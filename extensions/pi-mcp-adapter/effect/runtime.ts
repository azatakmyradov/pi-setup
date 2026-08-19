import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import type { McpConfig, ToolMetadata } from "../types.ts";
import { McpServerManager } from "../server-manager.ts";
import { makeCatalogLayer } from "./catalog-service.ts";
import { makeConfigLayer } from "./config-service.ts";
import { makeConnectionLayer } from "./connection-service.ts";
import { makeLifecycleLayer } from "./lifecycle-service.ts";
import {
  makeMcpServiceLayer,
  McpService,
  type McpServiceShape,
} from "./mcp-service.ts";
import type {
  McpCallResult,
  McpError,
  SearchQuery,
  ToolCall,
  ToolRef,
} from "./domain.ts";

export interface McpRuntimeOptions {
  readonly manager: McpServerManager;
  readonly config: McpConfig;
  readonly getMetadata: () => ReadonlyMap<string, ReadonlyArray<ToolMetadata>>;
  readonly getFailures?: () => ReadonlyMap<string, number>;
  /** Optional compatibility lifecycle facade; its health loop is scoped to this runtime. */
  readonly lifecycle?: { readonly checkConnectionsOnce: () => Promise<void> };
}

function makeAppLayer(options: McpRuntimeOptions) {
  const config = makeConfigLayer(options.config);
  const connection = makeConnectionLayer({
    manager: options.manager,
    config: options.config,
  });
  const catalog = makeCatalogLayer({
    config: options.config,
    getMetadata: options.getMetadata,
  });
  const mcp = makeMcpServiceLayer({
    manager: options.manager,
    config: options.config,
    getMetadata: options.getMetadata,
    getFailures: options.getFailures,
  });
  const lifecycle = options.lifecycle
    ? makeLifecycleLayer({ check: options.lifecycle.checkConnectionsOnce }, { autoStart: true })
    : Layer.empty;

  return mcp.pipe(
    Layer.provide(Layer.mergeAll(config, connection, catalog, lifecycle)),
  );
}

/** One resource-owning Effect runtime for one Pi session. */
export function createMcpRuntime(options: McpRuntimeOptions) {
  const ownedLayer = makeAppLayer(options).pipe(
    Layer.tap(() => Effect.logDebug("MCP Effect runtime initialized")),
  );
  return ManagedRuntime.make(ownedLayer);
}

export type McpRuntime = ReturnType<typeof createMcpRuntime>;

export function mcpServiceEffect<A>(
  select: (service: McpServiceShape) => Effect.Effect<A, McpError>,
): Effect.Effect<A, McpError, McpService> {
  return Effect.gen(function* () {
    const service = yield* McpService;
    return yield* select(service);
  });
}

export const mcpStatus = Effect.gen(function* () {
  const service = yield* McpService;
  return yield* service.status;
});

export const mcpConnect = (name: string) => mcpServiceEffect((service) => service.connect(name));
export const mcpDisconnect = (name: string) => mcpServiceEffect((service) => service.disconnect(name));
export const mcpSearch = (query: SearchQuery) => mcpServiceEffect((service) => service.search(query));
export const mcpDescribe = (tool: ToolRef) => mcpServiceEffect((service) => service.describe(tool));
export const mcpCall = (input: ToolCall) => mcpServiceEffect((service) => service.call(input));
export const mcpReadResource = (input: ToolCall & { readonly resourceUri: string }) =>
  mcpServiceEffect((service) => service.readResource(input));

/**
 * Run an Effect at the Pi boundary. AbortSignal interruption is preserved as a
 * real Effect interruption; typed failures are rendered only here.
 */
export async function runMcp<A, E>(
  runtime: McpRuntime,
  effect: Effect.Effect<A, E, McpService>,
  options: { readonly signal?: AbortSignal; readonly interruptMessage?: string } = {},
): Promise<A> {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "MCP operation was aborted.");
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}

/** Convert a typed failure into a model-safe string without exposing causes. */
export function safeMcpError(error: unknown): string {
  if (!error || typeof error !== "object") return "MCP operation failed.";
  const value = error as {
    readonly _tag?: unknown;
    readonly server?: unknown;
    readonly message?: unknown;
  };
  const server = typeof value.server === "string" ? value.server : undefined;
  switch (value._tag) {
    case "AuthenticationRequiredError":
      return server
        ? `MCP server "${server}" requires authentication. Authenticate it before retrying.`
        : "MCP server requires authentication. Authenticate it before retrying.";
    case "RequestTimeoutError":
      return "MCP request timed out.";
    case "InvalidToolArgumentsError":
      return typeof value.message === "string" ? value.message : "MCP tool arguments were invalid.";
    case "UnknownServerError":
      return typeof value.message === "string" ? value.message : "MCP server was not found.";
    case "ConnectionError":
      return server ? `MCP server "${server}" is unavailable.` : "MCP server is unavailable.";
    case "ToolCallError":
      return "MCP tool call failed.";
    case "RuntimeShutdownError":
      return "MCP runtime is shutting down.";
    default:
      return "MCP operation failed.";
  }
}
