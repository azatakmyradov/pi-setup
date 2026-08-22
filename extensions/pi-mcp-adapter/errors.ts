/**
 * Custom error types for MCP UI operations.
 * Provides structured errors with context and recovery hints.
 */

import { stringifyUnknown } from "./utils.ts";
import type { JsonValue } from "./json-value.ts";

export interface McpUiErrorContext {
  server?: string;
  tool?: string;
  uri?: string;
  session?: string;
  port?: number;
  mimeType?: string;
  [key: string]: JsonValue | undefined;
}

/** The serialized form of an {@link McpUiError}, as written to logs and tool results. */
export interface McpUiErrorReport {
  name: string;
  code: string;
  message: string;
  context: McpUiErrorContext;
  recoveryHint?: string;
  stack?: string;
}

/**
 * Base error class for MCP UI errors.
 */
export class McpUiError extends Error {
  readonly code: string;
  readonly context: McpUiErrorContext;
  readonly recoveryHint?: string;
  readonly cause?: Error;

  constructor(
    message: string,
    options: {
      code: string;
      context?: McpUiErrorContext;
      recoveryHint?: string;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = "McpUiError";
    this.code = options.code;
    this.context = options.context ?? {};
    this.recoveryHint = options.recoveryHint;
    this.cause = options.cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): McpUiErrorReport {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      recoveryHint: this.recoveryHint,
      stack: this.stack,
    };
  }
}

/**
 * Error fetching a UI resource from the MCP server.
 */
export class ResourceFetchError extends McpUiError {
  constructor(
    uri: string,
    reason: string,
    options?: { server?: string; cause?: Error }
  ) {
    super(`Failed to fetch UI resource "${uri}": ${reason}`, {
      code: "RESOURCE_FETCH_ERROR",
      context: { uri, server: options?.server },
      recoveryHint: "Check that the MCP server is connected and the resource URI is valid.",
      cause: options?.cause,
    });
    this.name = "ResourceFetchError";
  }
}

/**
 * Error parsing or validating UI resource content.
 */
export class ResourceParseError extends McpUiError {
  constructor(
    uri: string,
    reason: string,
    options?: { server?: string; mimeType?: string }
  ) {
    super(`Invalid UI resource "${uri}": ${reason}`, {
      code: "RESOURCE_PARSE_ERROR",
      context: { uri, server: options?.server, mimeType: options?.mimeType },
      recoveryHint: "Ensure the resource returns valid HTML with the correct MIME type.",
    });
    this.name = "ResourceParseError";
  }
}

/**
 * Error connecting to the AppBridge.
 */
export class BridgeConnectionError extends McpUiError {
  constructor(reason: string, options?: { session?: string; cause?: Error }) {
    super(`AppBridge connection failed: ${reason}`, {
      code: "BRIDGE_CONNECTION_ERROR",
      context: { session: options?.session },
      recoveryHint: "Check browser console for detailed errors. The iframe may have failed to load.",
      cause: options?.cause,
    });
    this.name = "BridgeConnectionError";
  }
}

/**
 * Error related to user consent for tool calls.
 */
export class ConsentError extends McpUiError {
  readonly denied: boolean;

  constructor(
    server: string,
    options: { denied?: boolean; requiresApproval?: boolean }
  ) {
    const message = options.denied
      ? `Tool calls for "${server}" were denied for this session`
      : `Tool call approval required for "${server}"`;

    super(message, {
      code: options.denied ? "CONSENT_DENIED" : "CONSENT_REQUIRED",
      context: { server },
      recoveryHint: options.denied
        ? "The user denied tool access. Start a new session to try again."
        : "Prompt the user for consent before calling tools.",
    });
    this.name = "ConsentError";
    this.denied = options.denied ?? false;
  }
}

/**
 * Error with UI server session management.
 */
export class SessionError extends McpUiError {
  constructor(
    reason: string,
    options?: { session?: string; cause?: Error }
  ) {
    super(`Session error: ${reason}`, {
      code: "SESSION_ERROR",
      context: { session: options?.session },
      recoveryHint: "The session may have expired or been closed. Try opening the UI again.",
      cause: options?.cause,
    });
    this.name = "SessionError";
  }
}

/**
 * Error starting or operating the UI server.
 */
export class ServerError extends McpUiError {
  constructor(
    reason: string,
    options?: { port?: number; cause?: Error }
  ) {
    super(`UI server error: ${reason}`, {
      code: "SERVER_ERROR",
      context: { port: options?.port },
      recoveryHint: "Check if the port is available. Another process may be using it.",
      cause: options?.cause,
    });
    this.name = "ServerError";
  }
}

/**
 * Error communicating with the MCP server.
 */
export class McpServerError extends McpUiError {
  constructor(
    server: string,
    reason: string,
    options?: { tool?: string; cause?: Error }
  ) {
    super(`MCP server "${server}" error: ${reason}`, {
      code: "MCP_SERVER_ERROR",
      context: { server, tool: options?.tool },
      recoveryHint: "Check that the MCP server is running and responsive.",
      cause: options?.cause,
    });
    this.name = "McpServerError";
  }
}

/**
 * Wrap an unknown error into an McpUiError.
 */
export function wrapError(cause: unknown, context?: McpUiErrorContext): McpUiError {
  if (cause instanceof McpUiError) {
    // Merge contexts
    return new McpUiError(cause.message, {
      code: cause.code,
      context: { ...cause.context, ...context },
      recoveryHint: cause.recoveryHint,
      cause: cause.cause,
    });
  }

  return new McpUiError(cause instanceof Error ? cause.message : stringifyUnknown(cause), {
    code: "UNKNOWN_ERROR",
    context,
    cause: cause instanceof Error ? cause : undefined,
  });
}

/**
 * Check if an error is a specific MCP UI error type.
 */
export function isErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof McpUiError && cause.code === code;
}
