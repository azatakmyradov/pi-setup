import { Context, Effect, Layer, Option, Schema } from "effect";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig, ToolMetadata } from "../types.ts";
import { McpServerManager } from "../server-manager.ts";
import { stringifyUnknown } from "../utils.ts";
import { CatalogService } from "./catalog-service.ts";
import { ConnectionService } from "./connection-service.ts";
import {
  AuthenticationRequiredError,
  ConnectionError,
  InvalidToolArgumentsError,
  RequestTimeoutError,
  RuntimeShutdownError,
  ToolCallError,
  UnknownServerError,
  readFailureFacts,
  type CatalogEntry,
  type Connection,
  type McpCallResult,
  type McpError,
  type McpReply,
  type ServerStatus,
  type SearchQuery,
  type ToolCall,
  type ToolRef,
} from "./domain.ts";
import { McpRuntimeSource } from "./runtime-source.ts";

export interface McpServiceApi {
  readonly status: Effect.Effect<ReadonlyArray<ServerStatus>>;
  readonly connect: (name: string) => Effect.Effect<Connection, McpError>;
  readonly disconnect: (name: string) => Effect.Effect<void, McpError>;
  readonly search: (query: SearchQuery) => Effect.Effect<ReadonlyArray<CatalogEntry>, McpError>;
  readonly describe: (tool: ToolRef) => Effect.Effect<CatalogEntry, McpError>;
  readonly call: (input: ToolCall) => Effect.Effect<McpCallResult, McpError>;
  readonly readResource: (input: ToolCall & { readonly resourceUri: string }) => Effect.Effect<McpCallResult, McpError>;
}

/** The single Effect-owned MCP operation surface used by all access modes. */
export class McpService extends Context.Service<
  McpService,
  McpServiceApi
>()("pi-mcp-adapter/McpService") {}

const FAILURE_BACKOFF_MS = 60_000;

export interface McpServiceSource {
  readonly manager: McpServerManager;
  readonly config: McpConfig;
  readonly getMetadata: () => ReadonlyMap<string, ReadonlyArray<ToolMetadata>>;
  readonly getFailures?: () => ReadonlyMap<string, number>;
}

function errorMessage<TError>(error: TError): string {
  return error instanceof Error ? error.message : stringifyUnknown(error);
}

function isTimeout<TError>(error: TError): boolean {
  const facts = readFailureFacts(error);
  return `${facts.name ?? ""} ${facts.message ?? ""}`.toLowerCase().includes("timeout");
}

function isAbort<TError>(error: TError): boolean {
  const facts = readFailureFacts(error);
  return facts.name === "AbortError" || facts.code === "ABORT_ERR";
}

const decodeReplyBlocks = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeReplyFlag = Schema.decodeUnknownOption(Schema.Boolean);

function asCallResult(
  server: string,
  tool: string,
  raw: McpReply,
): McpCallResult {
  // Both reply schemas are passthrough records, so every field below is decoded
  // rather than read: the SDK only guarantees that one of the two block lists is
  // present.
  const blocks = Option.orElse(
    decodeReplyBlocks("content" in raw ? raw.content : undefined),
    () => decodeReplyBlocks("contents" in raw ? raw.contents : undefined),
  );
  return {
    server,
    tool,
    isError: Option.getOrUndefined(decodeReplyFlag("isError" in raw ? raw.isError : undefined)),
    content: Option.getOrElse(blocks, () => []),
    structuredContent: "structuredContent" in raw ? raw.structuredContent : undefined,
    raw,
  };
}

function directEntry(server: string, tool: string): CatalogEntry {
  return {
    server,
    tool: {
      name: tool,
      originalName: tool,
      description: "",
    },
  };
}

function mcpService(source: McpServiceSource) {
  return Effect.gen(function* () {
    // The runtime owns the manager's transports/processes. The imperative
    // lifecycle facade may also close them, but closeAll is intentionally
    // idempotent so disposal remains safe during session races.
    yield* Effect.addFinalizer(() => Effect.tryPromise({
      try: () => source.manager.closeAll(),
      catch: () => undefined,
    }).pipe(Effect.ignore));

    const catalog = yield* CatalogService;
    const connections = yield* ConnectionService;

    const resolveEntry = (input: ToolCall): Effect.Effect<CatalogEntry, InvalidToolArgumentsError> => {
      if (input.server) {
        return catalog.resolve({ name: input.tool, server: input.server }).pipe(
          Effect.catchTag("InvalidToolArgumentsError", () => Effect.succeed(directEntry(input.server!, input.tool))),
        );
      }
      return catalog.resolve({ name: input.tool });
    };

    const call = (input: ToolCall): Effect.Effect<McpCallResult, McpError> => Effect.gen(function* () {
      const entry = yield* resolveEntry(input);
      const server = input.server ?? entry.server;
      const connection = yield* connections.requireConnected(server);
      const originalName = entry.tool.resourceUri ? entry.tool.originalName : input.tool === entry.tool.name ? entry.tool.originalName : input.tool;
      const resourceUri = input.resourceUri ?? entry.tool.resourceUri;

      source.manager.touch(server);
      source.manager.incrementInFlight(server);

      const operation: Effect.Effect<
        McpReply,
        ToolCallError | RequestTimeoutError
      > = resourceUri
        ? Effect.tryPromise({
            try: (signal) => connection.client.readResource(
              { uri: resourceUri },
              source.manager.getRequestOptions(server, signal),
            ),
            catch: (error) => {
              if (isAbort(error)) {
                return new ToolCallError({
                  message: `MCP resource read was aborted.`,
                  server,
                  tool: originalName,
                  cause: error,
                });
              }
              if (isTimeout(error)) {
                return new RequestTimeoutError({
                  message: `MCP resource read timed out.`,
                  server,
                  tool: originalName,
                  cause: error,
                });
              }
              return new ToolCallError({
                message: `Failed to read MCP resource: ${errorMessage(error)}`,
                server,
                tool: originalName,
                cause: error,
              });
            },
          })
        : Effect.tryPromise({
            try: (signal) => connection.client.callTool({
              name: originalName,
              arguments: input.arguments ?? {},
              _meta: input.meta,
            }, undefined, source.manager.getRequestOptions(server, signal)),
            catch: (error) => {
              if (isAbort(error)) {
                return new ToolCallError({
                  message: `MCP tool call was aborted.`,
                  server,
                  tool: originalName,
                  cause: error,
                });
              }
              if (isTimeout(error)) {
                return new RequestTimeoutError({
                  message: `MCP tool call timed out.`,
                  server,
                  tool: originalName,
                  cause: error,
                });
              }
              return new ToolCallError({
                message: `Failed to call MCP tool: ${errorMessage(error)}`,
                server,
                tool: originalName,
                cause: error,
              });
            },
          });

      const handledElicitation = operation.pipe(
        Effect.catch((error) => {
          const cause = error.cause;
          if (!(error instanceof ToolCallError) || !(cause instanceof UrlElicitationRequiredError)) {
            return Effect.fail(error);
          }
          return Effect.tryPromise({
            try: () => source.manager.handleUrlElicitationRequired(server, cause),
            catch: (cause) => new ToolCallError({
              message: "MCP URL interaction could not be started.",
              server,
              tool: originalName,
              cause,
            }),
          }).pipe(
            Effect.flatMap((action) => Effect.fail(new ToolCallError({
              message: action === "accept"
                ? "The MCP tool did not run. Complete the opened browser interaction, then retry the tool."
                : `The MCP URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`,
              server,
              tool: originalName,
            }))),
          );
        }),
      );

      return yield* handledElicitation.pipe(
        Effect.map((result) => asCallResult(
          server,
          originalName,
          result,
        )),
        Effect.ensuring(Effect.sync(() => {
          source.manager.decrementInFlight(server);
          source.manager.touch(server);
        })),
      );
    });

    const status = Effect.gen(function* () {
      const connectionsByName = yield* connections.all;
      const names = Object.keys(source.config.mcpServers);
      const failures = source.getFailures?.();
      const entries = source.getMetadata();
      return names.map((name): ServerStatus => {
        const connection = connectionsByName.get(name);
        const failedAt = failures?.get(name);
        if (connection?.status === "connected") {
          return { name, status: "connected", toolCount: entries.get(name)?.length ?? connection.tools.length };
        }
        if (connection?.status === "needs-auth") {
          return { name, status: "needs-auth", toolCount: entries.get(name)?.length ?? 0 };
        }
        if (failedAt !== undefined && Date.now() - failedAt <= FAILURE_BACKOFF_MS) {
          return { name, status: "failed", toolCount: entries.get(name)?.length ?? 0, failedAt };
        }
        if (entries.has(name)) {
          return { name, status: "cached", toolCount: entries.get(name)?.length ?? 0 };
        }
        return { name, status: "disconnected", toolCount: 0 };
      });
    });

    return McpService.of({
      status,
      connect: (name) => connections.connect(name),
      disconnect: (name) => connections.disconnect(name),
      search: (query) => catalog.search(query),
      describe: (tool) => catalog.describe(tool),
      call,
      readResource: (input) => call(input),
    });
  });
}

/** The single MCP operation capability, composed over the catalog and connection capabilities. */
export const mcpServiceLayer: Layer.Layer<
  McpService,
  never,
  CatalogService | ConnectionService | McpRuntimeSource
> = Layer.effect(
  McpService,
  Effect.gen(function* () {
    const source = yield* McpRuntimeSource;
    return yield* mcpService(source);
  }),
);

/** Keep the error imports part of this module's public type surface. */
export type McpServiceError =
  | AuthenticationRequiredError
  | ConnectionError
  | InvalidToolArgumentsError
  | RequestTimeoutError
  | RuntimeShutdownError
  | ToolCallError
  | UnknownServerError;
