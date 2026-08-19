import { Data, type Effect as EffectModule } from "effect";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig, McpResource, McpTool, ToolMetadata } from "../types.ts";

/** A stable, non-secret error message that is safe to cross the Pi boundary. */
export type McpErrorFields = {
  readonly message: string;
  readonly server?: string;
  readonly tool?: string;
  readonly cause?: unknown;
};

export class UnknownServerError extends Data.TaggedError("UnknownServerError")<McpErrorFields> {}
export class ConnectionError extends Data.TaggedError("ConnectionError")<McpErrorFields> {}
export class AuthenticationRequiredError extends Data.TaggedError("AuthenticationRequiredError")<McpErrorFields> {}
export class ToolCallError extends Data.TaggedError("ToolCallError")<McpErrorFields> {}
export class RequestTimeoutError extends Data.TaggedError("RequestTimeoutError")<McpErrorFields> {}
export class InvalidToolArgumentsError extends Data.TaggedError("InvalidToolArgumentsError")<McpErrorFields> {}
export class SearchError extends Data.TaggedError("SearchError")<McpErrorFields> {}
export class RuntimeShutdownError extends Data.TaggedError("RuntimeShutdownError")<McpErrorFields> {}

export type McpError =
  | UnknownServerError
  | ConnectionError
  | AuthenticationRequiredError
  | ToolCallError
  | RequestTimeoutError
  | InvalidToolArgumentsError
  | SearchError
  | RuntimeShutdownError;

export type ConnectionStatus = "connected" | "closed" | "needs-auth";

/** Public connection information. The SDK client and transport stay private. */
export interface Connection {
  readonly name: string;
  readonly definition: McpConfig["mcpServers"][string];
  readonly status: ConnectionStatus;
  readonly tools: ReadonlyArray<McpTool>;
  readonly resources: ReadonlyArray<McpResource>;
  readonly lastUsedAt: number;
  readonly inFlight: number;
}

export interface ServerStatus {
  readonly name: string;
  readonly status: "connected" | "needs-auth" | "failed" | "cached" | "disconnected";
  readonly toolCount: number;
  readonly failedAt?: number;
}

export interface SearchQuery {
  readonly query: string;
  readonly regex?: boolean;
  readonly server?: string;
  readonly includeSchemas?: boolean;
}

export interface ToolRef {
  readonly name: string;
  readonly server?: string;
}

export interface ToolCall {
  /** Original MCP server name. If omitted, the catalog resolves it. */
  readonly server?: string;
  /** Original MCP tool name, not the Pi-prefixed display name. */
  readonly tool: string;
  readonly arguments?: Record<string, unknown>;
  readonly resourceUri?: string;
  readonly meta?: Record<string, unknown>;
}

export interface McpCallResult {
  readonly server: string;
  readonly tool: string;
  readonly isError?: boolean;
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly raw: CallToolResult | ReadResourceResult;
}

export interface CatalogEntry {
  readonly server: string;
  readonly tool: ToolMetadata;
}

export type EffectResult<A, E = McpError> = EffectModule.Effect<A, E>;

export type LiveConnection = {
  readonly name: string;
  readonly definition: McpConfig["mcpServers"][string];
  readonly status: ConnectionStatus;
  readonly tools: McpTool[];
  readonly resources: McpResource[];
  readonly lastUsedAt: number;
  readonly inFlight: number;
};
