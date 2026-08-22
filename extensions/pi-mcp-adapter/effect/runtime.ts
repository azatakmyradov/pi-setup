import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { catalogLayer } from "./catalog-service.ts";
import { mcpConfigLayer } from "./config-service.ts";
import { connectionLayer } from "./connection-service.ts";
import { lifecycleLayer } from "./lifecycle-service.ts";
import { mcpServiceLayer, McpService, type McpServiceApi } from "./mcp-service.ts";
import { McpRuntimeSource, type McpRuntimeInputs } from "./runtime-source.ts";
import {
  readFailureFacts,
  type McpError,
  type SearchQuery,
  type ToolCall,
  type ToolRef,
} from "./domain.ts";

export type McpRuntimeOptions = McpRuntimeInputs;

function appLayer(options: McpRuntimeOptions) {
  return mcpServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(mcpConfigLayer, connectionLayer, catalogLayer, lifecycleLayer)),
    Layer.provide(Layer.succeed(McpRuntimeSource, McpRuntimeSource.of(options))),
  );
}

/** One resource-owning Effect runtime for one Pi session. */
export function createMcpRuntime(options: McpRuntimeOptions) {
  const ownedLayer = appLayer(options).pipe(
    Layer.tap(() => Effect.logDebug("MCP Effect runtime initialized")),
  );
  return ManagedRuntime.make(ownedLayer);
}

export type McpRuntime = ReturnType<typeof createMcpRuntime>;

export function mcpServiceEffect<A>(
  select: (service: McpServiceApi) => Effect.Effect<A, McpError>,
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
export function safeMcpError<TError>(error: TError): string {
  const { tag, server, message } = readFailureFacts(error);
  switch (tag) {
    case "AuthenticationRequiredError":
      return server
        ? `MCP server "${server}" requires authentication. Authenticate it before retrying.`
        : "MCP server requires authentication. Authenticate it before retrying.";
    case "RequestTimeoutError":
      return "MCP request timed out.";
    case "InvalidToolArgumentsError":
      return message ?? "MCP tool arguments were invalid.";
    case "UnknownServerError":
      return message ?? "MCP server was not found.";
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
