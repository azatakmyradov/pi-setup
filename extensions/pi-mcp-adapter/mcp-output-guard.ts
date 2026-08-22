import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { stringifyUnknown } from "./utils.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asJsonObject,
  asJsonText,
  jsonTextSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./json-value.ts";
import type { ContentBlock, McpSettings } from "./types.ts";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;

const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

export interface McpOutputGuardDetails {
  truncated: true;
  originalBytes: number;
  returnedBytes: number;
  originalLines: number;
  returnedLines: number;
  /** Number of image content blocks returned untouched alongside the truncated text. */
  imageBlocksPassedThrough?: number;
  fullOutputPath?: string;
  writeError?: string;
}

/** Size of one text output, in UTF-8 bytes and newline-separated lines. */
interface TextStats {
  bytes: number;
  lines: number;
}

/** Remaining room for a truncated preview once its notice is accounted for. */
interface PreviewBudget {
  maxBytes: number;
  maxLines: number;
}

/** A head-truncated text preview with its own measured size. */
interface TruncatedText {
  content: string;
  bytes: number;
  lines: number;
}

/** Size accounting for one MCP content block whose payload was dropped. */
export interface McpContentSummary {
  type: string;
  bytes?: number;
  lines?: number;
  textOmitted?: boolean;
  mimeType?: string;
  dataBytes?: number;
  dataOmitted?: boolean;
  estimatedBytes?: number;
  omitted?: boolean;
  /** Number of trailing content blocks left out of the summary entirely. */
  count?: number;
}

/** Size accounting for one dropped JSON value of an MCP result. */
export interface McpValueSummary {
  type: string;
  estimatedBytes: number;
  keyCount?: number;
  keysPreview?: string[];
  omitted: true;
}

/** Size accounting for one dropped non-standard field of an MCP result. */
export interface McpExtraFieldSummary {
  key: string;
  type: string;
  estimatedBytes: number;
  omitted: true;
}

export interface McpResultSummary {
  omitted: true;
  reason: string;
  isError: boolean;
  contentBlocks: number;
  contentSummary: McpContentSummary[];
  structuredContent?: McpValueSummary;
  meta?: McpValueSummary;
  extraFields?: McpExtraFieldSummary[];
  rawResultBytes: number;
  fullResultPath?: string;
  resultWriteError?: string;
}

export interface McpOutputGuardOptions {
  enabled?: boolean;
  prefix?: string;
  suffix?: string;
  emptyTextFallback?: string;
  maxBytes?: number;
  maxLines?: number;
  detailsMaxBytes?: number;
  /**
   * Raw MCP result to expose as details.mcpResult. Kept raw when its JSON
   * fits detailsMaxBytes (or when the guard is disabled); otherwise replaced
   * with a compact summary and spilled to a temp file. Omit for call sites
   * whose details never carried the raw result (e.g. direct tools).
   */
  rawMcpResult?: unknown;
}

export interface GuardedMcpOutput {
  content: ContentBlock[];
  outputGuard?: McpOutputGuardDetails;
  mcpResult?: unknown;
}

/** The tool-result details fields contributed by the output guard. */
export interface GuardedMcpDetails {
  mcpResult?: unknown;
  outputGuard?: McpOutputGuardDetails;
}

export function resolveMcpOutputGuardOptions(
  settings?: McpSettings,
): Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes"> {
  const configured = settings?.outputGuard;
  const tuning =
    configured === true || configured === false || configured === undefined
      ? undefined
      : configured;
  return {
    enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
    maxBytes: positiveInt(tuning?.maxBytes) ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
    maxLines: positiveInt(tuning?.maxLines) ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
    detailsMaxBytes: positiveInt(tuning?.detailsMaxBytes) ?? DEFAULT_MCP_DETAILS_MAX_BYTES,
  };
}

/** Tool-result details for the output guard: mcpResult/outputGuard only when present. */
export function guardedMcpDetails(guarded: GuardedMcpOutput): GuardedMcpDetails {
  const details: GuardedMcpDetails = {};
  if (guarded.mcpResult !== undefined) details.mcpResult = guarded.mcpResult;
  if (guarded.outputGuard) details.outputGuard = guarded.outputGuard;
  return details;
}

/**
 * Bound model-facing MCP output. Text output is capped at maxBytes/maxLines and
 * spilled to a temp file when oversized. Image blocks pass through untouched —
 * they are delivered to the provider as native image content, not text context.
 */
export async function guardMcpOutput(
  content: ContentBlock[],
  options: McpOutputGuardOptions = {},
): Promise<GuardedMcpOutput> {
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const detailsMaxBytes = options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES;
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";

  const normalizedContent = withEmptyTextFallback(
    content.length > 0
      ? sanitizeContent(content)
      : [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
    options.emptyTextFallback,
  );

  if (options.enabled === false) {
    return {
      content: addAffixes(normalizedContent, prefix, suffix),
      mcpResult: options.rawMcpResult,
    };
  }

  const imageBlocks = normalizedContent.filter((block) => block.type === "image");
  const textOutput = joinTextBlocks(normalizedContent);
  const composedOutput = `${prefix}${textOutput}${suffix}`;
  const stats = textStats(composedOutput);

  let guardedContent: ContentBlock[] = addAffixes(normalizedContent, prefix, suffix);
  let outputGuard: McpOutputGuardDetails | undefined;

  if (stats.bytes > maxBytes || stats.lines > maxLines) {
    const { path: fullOutputPath, error: writeError } = await saveArtifact(
      "output",
      composedOutput,
    );
    const notice = formatTruncationNotice(stats, fullOutputPath, writeError);
    const previewBudget = reserveBudget(maxBytes, maxLines, notice);
    const preview = truncateHead(composedOutput, previewBudget.maxBytes, previewBudget.maxLines);
    const finalText = `${preview.content}\n\n${notice}`;
    const finalStats = textStats(finalText);

    guardedContent = [{ type: "text" as const, text: finalText }, ...imageBlocks];
    const details: McpOutputGuardDetails = {
      truncated: true,
      originalBytes: stats.bytes,
      returnedBytes: finalStats.bytes,
      originalLines: stats.lines,
      returnedLines: finalStats.lines,
    };
    if (imageBlocks.length > 0) details.imageBlocksPassedThrough = imageBlocks.length;
    details.fullOutputPath = fullOutputPath;
    details.writeError = writeError;
    outputGuard = details;
  }

  const mcpResult =
    options.rawMcpResult === undefined
      ? undefined
      : await boundMcpResult(options.rawMcpResult, detailsMaxBytes);

  return { content: guardedContent, outputGuard, mcpResult };
}

function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const declared = jsonTextSchema.safeParse(block.mimeType).data?.trim();
    const mimeType = declared ? declared.slice(0, 100) : "image/png";
    return { ...block, mimeType };
  });
}

/** The text carried by a content list, in block order. */
function joinTextBlocks(content: ContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function withEmptyTextFallback(
  content: ContentBlock[],
  fallback: string | undefined,
): ContentBlock[] {
  if (!fallback) return content;
  if (joinTextBlocks(content)) return content;
  return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
  if (!prefix && !suffix) return content;
  const next: ContentBlock[] = [...content];

  if (prefix) {
    const index = next.findIndex((block) => block.type === "text");
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${prefix}${block.text}` };
    } else {
      next.unshift({ type: "text", text: prefix });
    }
  }

  if (suffix) {
    let index = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].type === "text") {
        index = i;
        break;
      }
    }
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${block.text}${suffix}` };
    } else {
      next.push({ type: "text", text: suffix });
    }
  }

  return next;
}

function reserveBudget(maxBytes: number, maxLines: number, notice: string): PreviewBudget {
  const noticeStats = textStats(`\n\n${notice}`);
  return {
    maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
    maxLines: Math.max(0, maxLines - noticeStats.lines),
  };
}

function truncateHead(text: string, maxBytes: number, maxLines: number): TruncatedText {
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (output.length >= maxLines) break;
    const separatorBytes = output.length > 0 ? 1 : 0;
    const lineBytes = byteLength(line);
    if (bytes + separatorBytes + lineBytes > maxBytes) {
      const remaining = maxBytes - bytes - separatorBytes;
      if (remaining > 0) {
        output.push(truncateStringToBytes(line, remaining));
      }
      break;
    }
    output.push(line);
    bytes += separatorBytes + lineBytes;
  }

  const content = output.join("\n");
  const stats = textStats(content);
  return { content, bytes: stats.bytes, lines: stats.lines };
}

function truncateStringToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function formatTruncationNotice(
  stats: TextStats,
  fullOutputPath: string | undefined,
  writeError: string | undefined,
): string {
  const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
  if (fullOutputPath) {
    return `${base} Full text saved to: ${fullOutputPath} — use read with offset/limit or grep to inspect.]`;
  }
  return `${base} Full output could not be saved: ${writeError ?? "unknown error"}]`;
}

/**
 * Bound details.mcpResult: keep the raw result when its JSON fits within
 * detailsMaxBytes; otherwise replace it with a compact summary and spill the
 * raw JSON to a temp file.
 */
async function boundMcpResult<TRawResult>(
  result: TRawResult,
  detailsMaxBytes: number,
): Promise<McpResultSummary | TRawResult> {
  const raw = safeStringify(result);
  const rawBytes = byteLength(raw);
  if (rawBytes <= detailsMaxBytes) return result;
  return summarizeMcpResult(raw, rawBytes);
}

/**
 * Summarize an oversized MCP result from its own JSON text: the serialized form
 * is exactly what the summary describes, and decoding it once gives every
 * reader below a real JSON value contract.
 */
async function summarizeMcpResult(raw: string, rawBytes: number): Promise<McpResultSummary> {
  const { path: fullResultPath, error: resultWriteError } = await saveArtifact("mcp-result", raw);

  const record = asJsonObject(decodeJsonText(raw));
  const content = Array.isArray(record?.content) ? record.content : [];
  const summary: McpResultSummary = {
    omitted: true,
    reason:
      "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
    isError: record?.isError === true,
    contentBlocks: content.length,
    contentSummary: summarizeContent(content),
    rawResultBytes: rawBytes,
    fullResultPath,
    resultWriteError,
  };

  if (record && "structuredContent" in record) {
    summary.structuredContent = summarizeValue(record.structuredContent);
  }
  if (record && "_meta" in record) {
    summary.meta = summarizeValue(record._meta);
  }
  if (record) {
    const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
    const extraFields = Object.keys(record)
      .filter((key) => !standard.has(key))
      .slice(0, KEY_PREVIEW_LIMIT)
      .map((key): McpExtraFieldSummary => ({
        key: truncateKey(key),
        type: jsonTypeName(record[key]),
        estimatedBytes: estimateValueBytes(record[key]),
        omitted: true,
      }));
    if (extraFields.length > 0) summary.extraFields = extraFields;
  }

  return summary;
}

function summarizeContent(content: JsonValue[]): McpContentSummary[] {
  const summaries: McpContentSummary[] = content
    .slice(0, CONTENT_SUMMARY_LIMIT)
    .map((block): McpContentSummary => {
      const record = asJsonRecord(block);
      if (!record) return { type: jsonTypeName(block), omitted: true };
      if (record.type === "text") {
        const text = asJsonText(record.text) ?? "";
        return {
          type: "text",
          bytes: byteLength(text),
          lines: textStats(text).lines,
          textOmitted: true,
        };
      }
      if (record.type === "image") {
        const data = asJsonText(record.data) ?? "";
        return {
          type: "image",
          mimeType: asJsonText(record.mimeType),
          dataBytes: byteLength(data),
          dataOmitted: true,
        };
      }
      return {
        type: asJsonText(record.type) ?? "unknown",
        estimatedBytes: estimateValueBytes(record),
        omitted: true,
      };
    });
  if (content.length > CONTENT_SUMMARY_LIMIT) {
    summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
  }
  return summaries;
}

function summarizeValue(value: JsonValue | undefined): McpValueSummary {
  const record = asJsonRecord(value);
  if (!record) {
    return {
      type: value === null ? "null" : jsonTypeName(value),
      estimatedBytes: estimateValueBytes(value),
      omitted: true,
    };
  }
  const keys = Object.keys(record);
  return {
    type: Array.isArray(value) ? "array" : "object",
    estimatedBytes: estimateValueBytes(value),
    keyCount: keys.length,
    keysPreview: keys.slice(0, KEY_PREVIEW_LIMIT).map(truncateKey),
    omitted: true,
  };
}

function estimateValueBytes(value: JsonValue | undefined, depth = 0): number {
  if (value === null || value === undefined) return 0;
  const text = asJsonText(value);
  if (text !== undefined) return byteLength(text);
  if (value === true || value === false || Number.isFinite(value))
    return byteLength(safeStringify(value));
  const record = asJsonRecord(value);
  if (!record || depth >= 2) return 0;
  const values = Object.values(record).slice(0, KEY_PREVIEW_LIMIT);
  return values.reduce<number>((total, item) => total + estimateValueBytes(item, depth + 1), 0);
}

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}

async function saveArtifact(
  kind: string,
  text: string,
): Promise<{ path?: string; error?: string }> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
    const path = join(dir, `${kind}-${randomBytes(4).toString("hex")}.txt`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Decode the JSON text of an MCP result back into the JSON domain. */
function decodeJsonText(text: string): JsonValue | undefined {
  try {
    return jsonValueSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/**
 * Read a decoded JSON value as a keyed bag of members. Arrays are keyed by
 * index, matching how a JSON array enumerates under `Object.keys`.
 */
function asJsonRecord(value: JsonValue | undefined): JsonObject | undefined {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((entry, index) => [String(index), entry]));
  }
  return asJsonObject(value);
}

/** The `typeof` name a decoded JSON value reports, as used in size summaries. */
function jsonTypeName(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === true || value === false) return "boolean";
  if (asJsonText(value) !== undefined) return "string";
  if (Number.isFinite(value)) return "number";
  return "object";
}

function safeStringify<TValue>(value: TValue): string {
  try {
    return JSON.stringify(value, null, 2) ?? stringifyUnknown(value);
  } catch {
    return stringifyUnknown(value);
  }
}

function textStats(text: string): TextStats {
  return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
