import { Effect } from "effect";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as CodeMode from "./vendor/opencode-codemode/src/codemode.ts";
import * as Tool from "./vendor/opencode-codemode/src/tool.ts";
import { toolError } from "./vendor/opencode-codemode/src/tool-error.ts";
import type { JsonSchema } from "./vendor/opencode-codemode/src/tool.ts";
import type { McpExtensionState } from "./state.ts";
import type { ContentBlock, McpCodeModeSettings } from "./types.ts";
import { mcpCall, runMcp, safeMcpError } from "./effect/runtime.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";

export const DEFAULT_CODE_MODE_SETTINGS: Required<McpCodeModeSettings> = {
  enabled: false,
  catalogBudget: 2_000,
  timeoutMs: 60_000,
  maxToolCalls: 20,
  maxOutputBytes: 50 * 1024,
};

export interface ResolvedCodeModeSettings extends Required<McpCodeModeSettings> {}

export function resolveCodeModeSettings(value: boolean | McpCodeModeSettings | undefined): ResolvedCodeModeSettings {
  if (value === true) return { ...DEFAULT_CODE_MODE_SETTINGS, enabled: true };
  if (!value || typeof value !== "object") return DEFAULT_CODE_MODE_SETTINGS;

  return {
    enabled: value.enabled === true,
    catalogBudget: nonNegativeInt(value.catalogBudget, DEFAULT_CODE_MODE_SETTINGS.catalogBudget),
    timeoutMs: positiveInt(value.timeoutMs, DEFAULT_CODE_MODE_SETTINGS.timeoutMs),
    maxToolCalls: nonNegativeInt(value.maxToolCalls, DEFAULT_CODE_MODE_SETTINGS.maxToolCalls),
    maxOutputBytes: nonNegativeInt(value.maxOutputBytes, DEFAULT_CODE_MODE_SETTINGS.maxOutputBytes),
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function asJsonSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {} };
  }
  return value as JsonSchema;
}

function asArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function codeModeValue(result: {
  readonly content: ReadonlyArray<unknown>;
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}): Record<string, unknown> {
  return {
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    content: result.content,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  };
}

interface ChildCall {
  readonly name: string;
  status: "running" | "success" | "failure";
  durationMs?: number;
  message?: string;
}

export interface CodeModeDetails {
  readonly mode: "code";
  readonly childCalls: ReadonlyArray<ChildCall>;
  readonly toolCalls: ReadonlyArray<{ readonly name: string }>;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly truncated?: boolean;
  readonly [key: string]: unknown;
}

function textForValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[Code mode returned a non-serializable value]";
  }
}

function contentForValue(value: unknown): ContentBlock[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const blocks = record.content;
    if (Array.isArray(blocks)) {
      const content: ContentBlock[] = [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const candidate = block as Record<string, unknown>;
        if (candidate.type === "image" && typeof candidate.data === "string") {
          content.push({
            type: "image",
            data: candidate.data,
            mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : "application/octet-stream",
          });
        } else if (candidate.type === "text" && typeof candidate.text === "string") {
          content.push({ type: "text", text: candidate.text });
        }
      }
      if (content.length > 0) return content;
    }
  }
  return [{ type: "text", text: textForValue(value) }];
}

function buildToolTree(state: McpExtensionState): Record<string, Record<string, Tool.Definition<unknown>>> {
  const tree: Record<string, Record<string, Tool.Definition<unknown>>> = {};
  for (const [server, metadata] of state.toolMetadata) {
    // `$codemode` is reserved by the interpreter for discovery helpers.
    if (server === "$codemode") continue;
    const namespace = (tree[server] ??= {});
    for (const tool of metadata) {
      // Interactive MCP UI sessions stay at the Pi edge for now. Excluding
      // them avoids creating a nested browser/session lifecycle in CodeMode.
      if (tool.uiResourceUri) continue;
      const input = asJsonSchema(tool.inputSchema);
      namespace[tool.originalName] = Tool.make({
        description: tool.description || `(MCP tool ${server}/${tool.originalName})`,
        input,
        run: (rawArgs) => {
          const argumentsObject = asArguments(rawArgs);
          const effect = mcpCall({
            server,
            tool: tool.originalName,
            arguments: argumentsObject,
            ...(tool.resourceUri ? { resourceUri: tool.resourceUri } : {}),
          }).pipe(
            Effect.map(codeModeValue),
            Effect.catch((error) => Effect.fail(toolError(safeMcpError(error)))),
          );
          return effect;
        },
      });
    }
  }
  return tree;
}

function updateResult(
  onUpdate: AgentToolUpdateCallback<CodeModeDetails> | undefined,
  childCalls: ReadonlyArray<ChildCall>,
  toolCalls: ReadonlyArray<{ readonly name: string }>,
): void {
  onUpdate?.({
    content: [{ type: "text", text: childCalls.length === 0 ? "Running confined MCP code..." : `MCP code: ${childCalls.map((call) => `${call.status} ${call.name}`).join(", ")}` }],
    details: { mode: "code", childCalls, toolCalls },
  });
}

function initializeState(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
): Promise<McpExtensionState | null> {
  const current = getState();
  if (current) return Promise.resolve(current);
  const pending = getInitPromise();
  return pending ? pending : Promise.resolve(null);
}

export function createCodeModeExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
): (
  toolCallId: string,
  params: { readonly code: string },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CodeModeDetails> | undefined,
  ctx: ExtensionContext,
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
        content: [{ type: "text", text: "MCP code mode is disabled. Set settings.codeMode to true to enable it." }],
        details: { mode: "code", childCalls: [], toolCalls: [], error: "disabled" },
      };
    }

    const childCalls: ChildCall[] = [];
    const codeRuntime = CodeMode.make({
      tools: buildToolTree(state) as never,
      limits: {
        timeoutMs: settings.timeoutMs,
        maxToolCalls: settings.maxToolCalls,
        maxOutputBytes: settings.maxOutputBytes,
      },
      discovery: { catalogBudget: settings.catalogBudget },
      onToolCallStart: (call) => Effect.sync(() => {
        childCalls.push({ name: call.name, status: "running" });
        updateResult(onUpdate, childCalls, childCalls.map(({ name }) => ({ name })));
      }),
      onToolCallEnd: (call) => Effect.sync(() => {
        const current = childCalls[call.index];
        if (!current) return;
        childCalls[call.index] = {
          ...current,
          status: call.outcome,
          durationMs: call.durationMs,
          ...(call.message ? { message: call.message } : {}),
        };
        updateResult(onUpdate, childCalls, childCalls.map(({ name }) => ({ name })));
      }),
    });

    try {
      const result = await runMcp(
        state.runtime,
        codeRuntime.execute(params.code) as Effect.Effect<CodeMode.Result, never>,
        { signal, interruptMessage: "MCP code mode was aborted." },
      );
      const toolCalls = result.toolCalls ?? [];
      const failed = "error" in result;
      const details: CodeModeDetails = {
        mode: "code",
        childCalls,
        toolCalls,
        ...(failed ? { error: result.error } : { result: result.value }),
        ...(result.truncated ? { truncated: true } : {}),
      };
      const output = failed
        ? [{ type: "text" as const, text: `MCP code mode failed (${result.error.kind}): ${result.error.message}` }]
        : contentForValue(result.value);
      const guarded = await guardMcpOutput(output, {
        ...resolveMcpOutputGuardOptions(state.config.settings),
        maxBytes: Math.min(settings.maxOutputBytes, resolveMcpOutputGuardOptions(state.config.settings).maxBytes ?? settings.maxOutputBytes),
        rawMcpResult: result,
      });
      return {
        content: guarded.content,
        details: { ...details, ...guardedMcpDetails(guarded) },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = safeMcpError(error);
      return {
        content: [{ type: "text", text: `MCP code mode failed: ${message}` }],
        details: { mode: "code", childCalls, toolCalls: childCalls.map(({ name }) => ({ name })), error: "execution_failed" },
      };
    }
  };
}

export function codeModeToolDescription(
  state: McpExtensionState | null,
  configured?: boolean | McpCodeModeSettings,
): string {
  const settings = resolveCodeModeSettings(state?.config.settings?.codeMode ?? configured);
  return [
    "Confined MCP code mode. Write a small JavaScript program that calls tools.<server>.<tool>(input), aggregates the results, and returns JSON.",
    "Only cached MCP tools are exposed; child calls use the same MCP runtime, OAuth, cancellation, timeouts, exclusions, and output guards as proxy/direct calls.",
    `Limits: ${settings.maxToolCalls} child calls, ${settings.timeoutMs}ms, ${settings.maxOutputBytes} output bytes. Discover additional tools with tools.$codemode.search({ query }).`,
    "Imports, eval, Function, vm, process, filesystem, timers, fetch, and ambient network are unavailable.",
  ].join("\n\n");
}

export function codeModeToolParameters() {
  return Type.Object({
    code: Type.String({ description: "Confined JavaScript program. Use await tools.<server>.<tool>(input) and return only the fields needed." }),
  });
}
