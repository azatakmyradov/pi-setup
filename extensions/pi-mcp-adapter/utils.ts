import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { McpConfig, ServerEntry } from "./types.ts";
import { z } from "zod";
import {
  asJsonObject,
  jsonObjectSchema,
  jsonTextSchema,
  type JsonObject,
  type JsonValue,
} from "./json-value.ts";

/**
 * Values that JSON cannot encode but a human-facing renderer still has to show.
 * `z.number()` rejects the non-finite members, so they are listed explicitly.
 */
const nonTextPrimitiveSchema = z.union([
  z.number(),
  z.nan(),
  z.literal(Infinity),
  z.literal(-Infinity),
  z.boolean(),
  z.bigint(),
  z.symbol(),
]);

async function execOpen(pi: ExtensionAPI, target: string, browser?: string) {
  const os = platform();

  if (os === "darwin") {
    return browser ? pi.exec("open", ["-a", browser, target]) : pi.exec("open", [target]);
  }
  if (os === "win32") {
    return browser
      ? pi.exec("cmd", ["/c", "start", "", browser, target])
      : pi.exec("cmd", ["/c", "start", "", target]);
  }
  return browser ? pi.exec(browser, [target]) : pi.exec("xdg-open", [target]);
}

export async function openUrl(pi: ExtensionAPI, url: string, browser?: string): Promise<void> {
  const result = await execOpen(pi, url, browser);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

export async function openPath(pi: ExtensionAPI, targetPath: string): Promise<void> {
  const result = await execOpen(pi, targetPath);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open path (exit code ${result.code})`);
  }
}

export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array(Math.min(limit, items.length)).fill(null).map(() => worker());
  await Promise.all(workers);
  return results;
}

export function getConfigPathFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--mcp-config");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
}

export function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = interpolateEnvVars(value);
  }
  return resolved;
}

export function resolveConfigPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const resolved = interpolateEnvVars(value);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
}

export function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">): string | undefined {
  if (definition.bearerToken !== undefined) {
    return interpolateEnvVars(definition.bearerToken);
  }
  return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

export function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text;

  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > target * 0.6) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated + "...";
}

/**
 * Render any runtime value as human-readable text.
 *
 * This is a rendering boundary rather than a parsing one: callers hand over
 * whatever a tool result, a caught throw or a config field happened to hold, so
 * the input is deliberately unconstrained and each representation is decoded
 * here before it is printed.
 */
export function stringifyUnknown<TValue>(value: TValue): string {
  const text = jsonTextSchema.safeParse(value);
  if (text.success) return text.data;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const primitive = nonTextPrimitiveSchema.safeParse(value);
  if (primitive.success) return String(primitive.data);
  if (value instanceof Function) return String(value);
  if (value instanceof Error) return value.message;

  try {
    return JSON.stringify(value) ?? "Unknown value";
  } catch {
    return "Unserializable value";
  }
}

export function normalizeDirectToolInputSchema(schema: JsonValue | undefined): JsonObject {
  const decoded = jsonObjectSchema.safeParse(schema);
  const inputSchema = decoded.success ? decoded.data : { type: "object", properties: {} };
  return Object.fromEntries(
    Object.entries(inputSchema).filter(([key]) => key !== "$schema" && key !== "additionalProperties"),
  );
}

export function formatAuthRequiredMessage(
  config: Pick<McpConfig, "settings">,
  serverName: string,
  defaultMessage: string,
): string {
  const template = config.settings?.authRequiredMessage;
  return template ? template.replaceAll("${server}", serverName) : defaultMessage;
}

/**
 * Extract the adapter-owned UI stream mode from tool metadata.
 */
export function extractToolUiStreamMode(toolMeta: JsonObject | undefined): "eager" | "stream-first" | undefined {
  const streamMode = asJsonObject(toolMeta?.ui)?.["pi-mcp-adapter.streamMode"];
  if (streamMode === "eager" || streamMode === "stream-first") {
    return streamMode;
  }
  return undefined;
}
