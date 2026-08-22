import { Effect } from "effect";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import * as CodeMode from "./vendor/opencode-codemode/src/codemode.ts";
import * as Tool from "./vendor/opencode-codemode/src/tool.ts";
import { toolError } from "./vendor/opencode-codemode/src/tool-error.ts";
import type { JsonSchema } from "./vendor/opencode-codemode/src/tool.ts";
import type { SearchNotice } from "./vendor/opencode-codemode/src/tool-runtime.ts";
import type { McpExtensionState } from "./state.ts";
import type {
  ContentBlock,
  McpCodeModeSettings,
  McpConfig,
  McpContent,
  ToolMetadata,
} from "./types.ts";
import { mcpCall, runMcp, safeMcpError } from "./effect/runtime.ts";
import type { McpCallResult, ToolCall } from "./effect/domain.ts";
import type { McpService } from "./effect/mcp-service.ts";
import {
  asJsonObject,
  asJsonText,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./json-value.ts";
import {
  guardMcpOutput,
  guardedMcpDetails,
  resolveMcpOutputGuardOptions,
  type McpOutputGuardOptions,
} from "./mcp-output-guard.ts";
import {
  isServerCacheValid,
  reconstructToolMetadata,
  type MetadataCache,
} from "./metadata-cache.ts";
import { transformMcpContent } from "./tool-registrar.ts";

export const CODE_MODE_TOOL_NAME = "mcp_execute";

export const DEFAULT_CODE_MODE_SETTINGS: Required<McpCodeModeSettings> = {
  enabled: false,
  catalogBudget: 2_000,
  timeoutMs: 60_000,
  maxToolCalls: 20,
  maxOutputBytes: 50 * 1024,
};

export interface ResolvedCodeModeSettings extends Required<McpCodeModeSettings> {}

export function resolveCodeModeSettings(
  value: boolean | McpCodeModeSettings | undefined,
): ResolvedCodeModeSettings {
  if (value === true) return { ...DEFAULT_CODE_MODE_SETTINGS, enabled: true };
  if (!value) return DEFAULT_CODE_MODE_SETTINGS;

  return {
    enabled: value.enabled === true,
    catalogBudget: nonNegativeInt(value.catalogBudget, DEFAULT_CODE_MODE_SETTINGS.catalogBudget),
    timeoutMs: positiveInt(value.timeoutMs, DEFAULT_CODE_MODE_SETTINGS.timeoutMs),
    maxToolCalls: nonNegativeInt(value.maxToolCalls, DEFAULT_CODE_MODE_SETTINGS.maxToolCalls),
    maxOutputBytes: nonNegativeInt(value.maxOutputBytes, DEFAULT_CODE_MODE_SETTINGS.maxOutputBytes),
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

const codeModeJsonSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z.object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    enum: z.array(jsonValueSchema).optional(),
    const: jsonValueSchema.optional(),
    anyOf: z.array(codeModeJsonSchema).optional(),
    oneOf: z.array(codeModeJsonSchema).optional(),
    allOf: z.array(codeModeJsonSchema).optional(),
    properties: z.record(z.string(), codeModeJsonSchema).optional(),
    required: z.array(z.string()).optional(),
    items: codeModeJsonSchema.optional(),
    additionalProperties: z.union([z.boolean(), codeModeJsonSchema]).optional(),
    description: z.string().optional(),
    default: jsonValueSchema.optional(),
    format: z.string().optional(),
    deprecated: z.boolean().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    $ref: z.string().optional(),
    $defs: z.record(z.string(), codeModeJsonSchema).optional(),
    definitions: z.record(z.string(), codeModeJsonSchema).optional(),
  }),
);

const mcpContentSchema: z.ZodType<McpContent> = z.object({
  type: z.enum(["text", "image", "audio", "resource", "resource_link"]),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  resource: z
    .object({
      uri: z.string(),
      text: z.string().optional(),
      blob: z.string().optional(),
    })
    .optional(),
  uri: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

function decodeJsonSchema(value: JsonValue | undefined): JsonSchema {
  return codeModeJsonSchema.safeParse(value).data ?? { type: "object", properties: {} };
}

function decodeArguments<TArguments>(value: TArguments): JsonObject {
  return jsonObjectSchema.safeParse(value).data ?? {};
}

function decodeJsonValue<TValue>(value: TValue): JsonValue | undefined {
  return jsonValueSchema.safeParse(value).data;
}

async function codeModeValue(
  result: McpCallResult,
  outputGuardOptions:
    | Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes">
    | undefined,
): Promise<JsonObject> {
  const jsonContent = result.content.flatMap((block) => {
    const decoded = decodeJsonValue(block);
    return decoded === undefined ? [] : [decoded];
  });
  const mcpContent = jsonContent.flatMap((block) => {
    const decoded = mcpContentSchema.safeParse(block);
    return decoded.success ? [decoded.data] : [];
  });
  const transformedContent = transformMcpContent(mcpContent);
  const guarded =
    outputGuardOptions && transformedContent.length > 0
      ? await guardMcpOutput(transformedContent, outputGuardOptions)
      : undefined;
  const guardedContent = guarded?.content.flatMap((block) => {
    const decoded = decodeJsonValue(block);
    return decoded === undefined ? [] : [decoded];
  });
  const output: JsonObject = { content: guardedContent ?? jsonContent };
  if (result.isError !== undefined) output.isError = result.isError;
  const structuredContent = decodeJsonValue(result.structuredContent);
  if (structuredContent !== undefined) output.structuredContent = structuredContent;
  const outputGuard = decodeJsonValue(guarded?.outputGuard);
  if (outputGuard !== undefined) output.outputGuard = outputGuard;
  return output;
}

interface ChildCall {
  readonly name: string;
  readonly input?: JsonObject;
  status: "running" | "success" | "failure";
  durationMs?: number;
  message?: string;
}

export interface CodeModeDetails {
  readonly mode: "code";
  readonly childCalls: ReadonlyArray<ChildCall>;
  readonly toolCalls: ReadonlyArray<{ readonly name: string }>;
  readonly result?: JsonValue;
  readonly error?:
    | CodeMode.Diagnostic
    | "not_initialized"
    | "runtime_unavailable"
    | "disabled"
    | "execution_failed";
  readonly truncated?: boolean;
}

function textForValue(value: JsonValue): string {
  const text = asJsonText(value);
  if (text !== undefined) return text;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[Code mode returned a non-serializable value]";
  }
}

function contentForValue(value: JsonValue): ContentBlock[] {
  const blocks = asJsonObject(value)?.content;
  if (Array.isArray(blocks)) {
    const content: ContentBlock[] = [];
    for (const block of blocks) {
      const candidate = asJsonObject(block);
      if (!candidate) continue;
      const type = asJsonText(candidate.type);
      const data = asJsonText(candidate.data);
      const text = asJsonText(candidate.text);
      if (type === "image" && data !== undefined) {
        content.push({
          type: "image",
          data,
          mimeType: asJsonText(candidate.mimeType) ?? "application/octet-stream",
        });
      } else if (type === "text" && text !== undefined) {
        content.push({ type: "text", text });
      }
    }
    if (content.length > 0) return content;
  }
  return [{ type: "text", text: textForValue(value) }];
}

interface CodeModeToolNamespace {
  [toolName: string]: Tool.Definition<McpService>;
}

interface CodeModeToolTree {
  [serverName: string]: CodeModeToolNamespace;
}

type CodeModeMetadata = ReadonlyMap<string, ReadonlyArray<ToolMetadata>>;

function buildToolTree(
  metadataByServer: CodeModeMetadata,
  outputGuardOptions?: Pick<
    McpOutputGuardOptions,
    "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes"
  >,
): CodeModeToolTree {
  const tree: CodeModeToolTree = {};
  for (const [server, metadata] of metadataByServer) {
    // `$codemode` is reserved by the interpreter for discovery helpers.
    if (server === "$codemode") continue;
    let namespace = tree[server];
    for (const tool of metadata) {
      // Interactive MCP UI sessions stay at the Pi edge for now. Excluding
      // them avoids creating a nested browser/session lifecycle in CodeMode.
      if (tool.uiResourceUri) continue;
      namespace ??= tree[server] = {};
      const input = decodeJsonSchema(tool.inputSchema);
      namespace[tool.originalName] = Tool.make({
        description: tool.description || `(MCP tool ${server}/${tool.originalName})`,
        input,
        run: (rawArgs) => {
          const argumentsObject = decodeArguments(rawArgs);
          const call: ToolCall = tool.resourceUri
            ? {
                server,
                tool: tool.originalName,
                arguments: argumentsObject,
                resourceUri: tool.resourceUri,
              }
            : { server, tool: tool.originalName, arguments: argumentsObject };
          const effect = mcpCall(call).pipe(
            Effect.flatMap((result) =>
              Effect.tryPromise({
                try: () => codeModeValue(result, outputGuardOptions),
                catch: (error) => toolError(safeMcpError(error)),
              }),
            ),
            Effect.catch((error) => Effect.fail(toolError(safeMcpError(error)))),
          );
          return effect;
        },
      });
    }
  }
  return tree;
}

export function buildCodeModeMetadataFromCache(
  config: McpConfig,
  cache: MetadataCache | null,
): Map<string, ToolMetadata[]> {
  const metadata = new Map<string, ToolMetadata[]>();
  if (!cache) return metadata;

  const prefix = config.settings?.toolPrefix ?? "server";
  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const entry = cache.servers[serverName];
    if (!entry || !isServerCacheValid(entry, definition)) continue;
    metadata.set(serverName, reconstructToolMetadata(serverName, entry, prefix, definition));
  }

  return metadata;
}

function configuredServersWithoutMetadata(config: McpConfig, metadata: CodeModeMetadata): string[] {
  return Object.keys(config.mcpServers).filter((serverName) => !metadata.has(serverName));
}

function formatServerList(servers: ReadonlyArray<string>): string {
  return servers.length === 1
    ? `"${servers[0]}"`
    : servers.map((server) => `"${server}"`).join(", ");
}

function reconnectHint(servers: ReadonlyArray<string>): string {
  if (servers.length === 1) return `/mcp reconnect ${servers[0]}`;
  return `/mcp reconnect <server> (for example, /mcp reconnect ${servers[0]})`;
}

function createSearchNotice(config: McpConfig, getMetadata: () => CodeModeMetadata): SearchNotice {
  return (request, summary) => {
    if (summary.matchCount > 0) return undefined;

    const missing = configuredServersWithoutMetadata(config, getMetadata());
    const relevant =
      request.namespace === undefined
        ? missing
        : missing.filter((serverName) => serverName === request.namespace);
    if (relevant.length === 0) return undefined;

    const scope = request.namespace === undefined ? "" : ` for namespace "${request.namespace}"`;
    const plural = relevant.length === 1 ? "server" : "servers";
    return `No Code Mode MCP tools are known${scope} yet. Cached metadata is missing for configured ${plural}: ${formatServerList(relevant)}. Run ${reconnectHint(relevant)} or refresh the server in the MCP panel, then retry ${CODE_MODE_TOOL_NAME}.`;
  };
}

function appendPiNotes(
  instructions: string,
  config: McpConfig,
  metadata: CodeModeMetadata,
  settings: ResolvedCodeModeSettings,
): string {
  const missing = configuredServersWithoutMetadata(config, metadata);
  const notes = [
    "",
    "## Pi MCP execution notes",
    "",
    `- ${CODE_MODE_TOOL_NAME} is the only model-facing MCP tool while code mode is enabled; the normal \`mcp\` proxy and direct MCP tools are hidden. User/admin \`/mcp\`, MCP panel, auth commands, lifecycle, and metadata cache behavior remain available.`,
    "- Child calls use Pi's Effect-owned MCP runtime: lazy MCP connect, OAuth/auth handling, cancellation signals, request timeouts, elicitation, and output guards all apply.",
    `- Limits: ${settings.maxToolCalls} child calls, ${settings.timeoutMs}ms wall time, ${settings.maxOutputBytes} output bytes.`,
    "- The confined program has no ambient network, filesystem, or process access; use listed Code Mode MCP tools for external operations.",
    ...(missing.length === 0
      ? []
      : [
          `- Cached metadata is missing for configured server${missing.length === 1 ? "" : "s"}: ${formatServerList(missing)}. Search will report this; run ${reconnectHint(missing)} or refresh the MCP panel before using tools from those servers.`,
        ]),
  ];
  return `${instructions}${notes.join("\n")}`;
}

function childCallInput<TInput>(value: TInput): JsonObject | undefined {
  if (value === null || value === undefined) return undefined;
  const decoded = decodeJsonValue(value);
  if (decoded === undefined) return undefined;
  const input = asJsonObject(decoded);
  if (!input) return { input: decoded };
  return Object.keys(input).length > 0 ? input : undefined;
}

function updateResult(
  onUpdate: AgentToolUpdateCallback<CodeModeDetails> | undefined,
  childCalls: ReadonlyArray<ChildCall>,
  toolCalls: ReadonlyArray<{ readonly name: string }>,
): void {
  const childCallSnapshot = childCalls.map((call) => ({ ...call }));
  const toolCallSnapshot = toolCalls.map((call) => ({ ...call }));
  onUpdate?.({
    content: [
      {
        type: "text",
        text:
          childCallSnapshot.length === 0
            ? "Running confined MCP code..."
            : `MCP code: ${childCallSnapshot.map((call) => `${call.status} ${call.name}`).join(", ")}`,
      },
    ],
    details: { mode: "code", childCalls: childCallSnapshot, toolCalls: toolCallSnapshot },
  });
}

type CodeModeState = Pick<McpExtensionState, "runtime" | "config" | "toolMetadata">;

function initializeState(
  getState: () => CodeModeState | null,
  getInitPromise: () => Promise<CodeModeState> | null,
): Promise<CodeModeState | null> {
  const current = getState();
  if (current) return Promise.resolve(current);
  const pending = getInitPromise();
  return pending ? pending : Promise.resolve(null);
}

export function createCodeModeExecutor(
  getState: () => CodeModeState | null,
  getInitPromise: () => Promise<CodeModeState> | null,
): (
  toolCallId: string,
  params: { readonly code: string },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CodeModeDetails> | undefined,
) => Promise<AgentToolResult<CodeModeDetails>> {
  return async (_toolCallId, params, signal, onUpdate) => {
    const state = await initializeState(getState, getInitPromise);
    if (!state) {
      return {
        content: [{ type: "text", text: "MCP not initialized" }],
        details: { mode: "code", childCalls: [], toolCalls: [], error: "not_initialized" },
      };
    }
    if (!state.runtime) {
      return {
        content: [{ type: "text", text: "MCP code mode is unavailable in this session." }],
        details: { mode: "code", childCalls: [], toolCalls: [], error: "runtime_unavailable" },
      };
    }

    const settings = resolveCodeModeSettings(state.config.settings?.codeMode);
    if (!settings.enabled) {
      return {
        content: [
          {
            type: "text",
            text: "MCP code mode is disabled. Set settings.codeMode to true to enable it.",
          },
        ],
        details: { mode: "code", childCalls: [], toolCalls: [], error: "disabled" },
      };
    }

    const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings);
    const maxGuardedBytes = Math.min(
      settings.maxOutputBytes,
      outputGuardOptions.maxBytes ?? settings.maxOutputBytes,
    );
    const childCalls: ChildCall[] = [];
    const codeRuntime = CodeMode.make({
      tools: buildToolTree(state.toolMetadata, {
        ...outputGuardOptions,
        maxBytes: maxGuardedBytes,
      }),
      limits: {
        timeoutMs: settings.timeoutMs,
        maxToolCalls: settings.maxToolCalls,
        maxOutputBytes: settings.maxOutputBytes,
      },
      discovery: {
        catalogBudget: settings.catalogBudget,
        searchNotice: createSearchNotice(state.config, () => state.toolMetadata),
      },
      onToolCallStart: (call) =>
        Effect.sync(() => {
          const input = childCallInput(call.input);
          const childCall: ChildCall = input
            ? { name: call.name, status: "running", input }
            : { name: call.name, status: "running" };
          childCalls.push(childCall);
          updateResult(
            onUpdate,
            childCalls,
            childCalls.map(({ name }) => ({ name })),
          );
        }),
      onToolCallEnd: (call) =>
        Effect.sync(() => {
          const current = childCalls[call.index];
          if (!current) return;
          const completed: ChildCall = {
            ...current,
            status: call.outcome,
            durationMs: call.durationMs,
          };
          if (call.message) completed.message = call.message;
          childCalls[call.index] = completed;
          updateResult(
            onUpdate,
            childCalls,
            childCalls.map(({ name }) => ({ name })),
          );
        }),
    });

    try {
      const result = await runMcp(state.runtime, codeRuntime.execute(params.code), {
        signal,
        interruptMessage: "MCP code mode was aborted.",
      });
      const toolCalls = result.toolCalls ?? [];
      const failed = "error" in result;
      const resultValue = failed ? undefined : (decodeJsonValue(result.value) ?? null);
      const successfulValue = resultValue ?? null;
      const details: CodeModeDetails = failed
        ? { mode: "code", childCalls, toolCalls, error: result.error }
        : { mode: "code", childCalls, toolCalls, result: successfulValue };
      const finalDetails: CodeModeDetails = result.truncated
        ? { ...details, truncated: true }
        : details;
      const output = failed
        ? [
            {
              type: "text" as const,
              text: `MCP code mode failed (${result.error.kind}): ${result.error.message}`,
            },
          ]
        : contentForValue(successfulValue);
      const guarded = await guardMcpOutput(output, {
        ...outputGuardOptions,
        maxBytes: maxGuardedBytes,
        rawMcpResult: result,
      });
      return {
        content: guarded.content,
        details: { ...finalDetails, ...guardedMcpDetails(guarded) },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = safeMcpError(error);
      return {
        content: [{ type: "text", text: `MCP code mode failed: ${message}` }],
        details: {
          mode: "code",
          childCalls,
          toolCalls: childCalls.map(({ name }) => ({ name })),
          error: "execution_failed",
        },
      };
    }
  };
}

export function codeModeToolDescription(config: McpConfig, metadata: CodeModeMetadata): string {
  const settings = resolveCodeModeSettings(config.settings?.codeMode);
  const runtime = CodeMode.make({
    tools: buildToolTree(metadata),
    discovery: {
      catalogBudget: settings.catalogBudget,
      searchNotice: createSearchNotice(config, () => metadata),
    },
  });
  return appendPiNotes(runtime.instructions(), config, metadata, settings);
}

export function codeModeToolParameters() {
  return Type.Object({
    code: Type.String({
      description:
        "Confined JavaScript program. Use await tools.<server>.<tool>(input) and return only the fields needed.",
    }),
  });
}
