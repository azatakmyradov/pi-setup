import { Context, Effect, Layer } from "effect";
import type { McpConfig, ServerDefinition } from "../types.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import { abortable } from "../abort.ts";
import {
  AuthenticationRequiredError,
  ConnectionError,
  RequestTimeoutError,
  UnknownServerError,
  type Connection,
} from "./domain.ts";

export interface ConnectionServiceShape {
  readonly get: (name: string) => Effect.Effect<ServerConnection | undefined>;
  readonly all: Effect.Effect<ReadonlyMap<string, ServerConnection>>;
  readonly connect: (name: string) => Effect.Effect<Connection, UnknownServerError | ConnectionError | AuthenticationRequiredError | RequestTimeoutError>;
  readonly disconnect: (name: string) => Effect.Effect<void, UnknownServerError | ConnectionError>;
  readonly requireConnected: (name: string) => Effect.Effect<ServerConnection, UnknownServerError | ConnectionError | AuthenticationRequiredError | RequestTimeoutError>;
}

export class ConnectionService extends Context.Service<
  ConnectionService,
  ConnectionServiceShape
>()("pi-mcp-adapter/ConnectionService") {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown): boolean {
  const value = error as { readonly name?: unknown; readonly message?: unknown };
  const text = `${value?.name ?? ""} ${value?.message ?? ""}`.toLowerCase();
  return text.includes("timeout") || text.includes("timed out");
}

function isAbort(error: unknown): boolean {
  const value = error as { readonly name?: unknown; readonly code?: unknown };
  return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

function publicConnection(name: string, connection: ServerConnection): Connection {
  return {
    name,
    definition: connection.definition,
    status: connection.status,
    tools: connection.tools,
    resources: connection.resources,
    lastUsedAt: connection.lastUsedAt,
    inFlight: connection.inFlight,
  };
}

export interface ConnectionSource {
  readonly manager: McpServerManager;
  readonly config: McpConfig;
}

export function makeConnectionLayer(source: ConnectionSource): Layer.Layer<ConnectionService> {
  // The manager also deduplicates connections, but keeping the promise at the
  // Effect boundary makes this invariant explicit and protects test/future
  // implementations of the legacy manager. A caller's abort only releases its
  // wait; it never cancels the shared connection attempt.
  const pending = new Map<string, Promise<ServerConnection>>();

  const connectServer = (name: string) => {
    const definition: ServerDefinition | undefined = source.config.mcpServers[name];
    if (!definition) {
      return Effect.fail(new UnknownServerError({
        message: `MCP server "${name}" is not configured.`,
        server: name,
      }));
    }

    const shared = pending.get(name) ?? (() => {
      const promise = source.manager.connect(name, definition, undefined, { ownAbort: true });
      pending.set(name, promise);
      promise.then(
        () => { if (pending.get(name) === promise) pending.delete(name); },
        () => { if (pending.get(name) === promise) pending.delete(name); },
      );
      return promise;
    })();

    return Effect.tryPromise({
      try: (signal) => abortable(shared, signal),
      catch: (error) => {
        if (isAbort(error)) {
          return new ConnectionError({
            message: `Connection to "${name}" was aborted.`,
            server: name,
            cause: error,
          });
        }
        if (isTimeout(error)) {
          return new RequestTimeoutError({
            message: `Connection to "${name}" timed out.`,
            server: name,
            cause: error,
          });
        }
        return new ConnectionError({
          message: `Failed to connect to "${name}": ${messageOf(error)}`,
          server: name,
          cause: error,
        });
      },
    }).pipe(
      Effect.flatMap((connection) => connection.status === "needs-auth"
        ? Effect.fail(new AuthenticationRequiredError({
            message: `MCP server "${name}" requires authentication.`,
            server: name,
          }))
        : Effect.succeed(publicConnection(name, connection))),
    );
  };

  const service = ConnectionService.of({
    get: (name) => Effect.sync(() => source.manager.getConnection(name)),
    all: Effect.sync(() => source.manager.getAllConnections()),
    connect: connectServer,
    disconnect: (name) => {
      if (!source.config.mcpServers[name]) {
        return Effect.fail(new UnknownServerError({
          message: `MCP server "${name}" is not configured.`,
          server: name,
        }));
      }
      return Effect.tryPromise({
        try: () => source.manager.close(name),
        catch: (error) => new ConnectionError({
          message: `Failed to disconnect from "${name}": ${messageOf(error)}`,
          server: name,
          cause: error,
        }),
      });
    },
    requireConnected: (name) => Effect.gen(function* () {
      const existing = yield* Effect.sync(() => source.manager.getConnection(name));
      if (existing?.status === "connected") return existing;
      if (existing?.status === "needs-auth") {
        return yield* new AuthenticationRequiredError({
          message: `MCP server "${name}" requires authentication.`,
          server: name,
        });
      }
      yield* connectServer(name);
      const connected = source.manager.getConnection(name);
      if (!connected || connected.status !== "connected") {
        return yield* new ConnectionError({
          message: `MCP server "${name}" is not connected after connect.`,
          server: name,
        });
      }
      return connected;
    }),
  });

  return Layer.succeed(ConnectionService, service);
}
