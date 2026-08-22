import { Data, Option, Schema, type Effect as EffectModule } from "effect";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig, McpResource, McpTool, ToolMetadata } from "../types.ts";
import type { JsonObject } from "../json-value.ts";

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

/**
 * The facts a rejected MCP promise carries. Transport rejections arrive from the
 * MCP SDK, from Node and from the OS, so they are decoded once here and every
 * classifier below branches on this domain record instead of on raw properties.
 */
export interface McpFailureFacts {
  readonly tag?: string;
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  readonly server?: string;
}

const failureFieldsSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  server: Schema.optionalKey(Schema.Unknown),
});

const decodeFailureFields = Schema.decodeUnknownOption(failureFieldsSchema);
const decodeFailureText = Schema.decodeUnknownOption(Schema.String);

const NO_FAILURE_FACTS: McpFailureFacts = {};

function readFailureText<TValue>(value: TValue): string | undefined {
  return Option.getOrUndefined(decodeFailureText(value));
}

/** Decode a rejected value into the failure facts the adapter is allowed to read. */
export function readFailureFacts<TError>(error: TError): McpFailureFacts {
  const fields = Option.getOrUndefined(decodeFailureFields(error));
  if (fields === undefined) return NO_FAILURE_FACTS;
  return {
    tag: readFailureText(fields._tag),
    name: readFailureText(fields.name),
    code: readFailureText(fields.code),
    message: readFailureText(fields.message),
    server: readFailureText(fields.server),
  };
}

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
  readonly arguments?: JsonObject;
  readonly resourceUri?: string;
  readonly meta?: JsonObject;
}

/**
 * Every reply the MCP SDK can hand back for a tool call or a resource read,
 * including the legacy `toolResult` compatibility envelope.
 */
export type McpReply = CallToolResult | CompatibilityCallToolResult | ReadResourceResult;

export interface McpCallResult {
  readonly server: string;
  readonly tool: string;
  readonly isError?: boolean;
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly raw: McpReply;
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
