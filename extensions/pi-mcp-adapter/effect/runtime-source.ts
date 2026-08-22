import { Context } from "effect";
import type { McpConfig, ToolMetadata } from "../types.ts";
import type { McpServerManager } from "../server-manager.ts";

/**
 * The imperative substrate one Pi session hands to the Effect runtime: the
 * connection manager it owns, the configuration it was started with, and the
 * metadata/failure views the session keeps updating.
 *
 * Every capability layer in this directory reads it as a contextual service, so
 * the layers stay static values and the session-owned inputs are provided once,
 * at the composition root in `runtime.ts`.
 */
export interface McpRuntimeInputs {
  readonly manager: McpServerManager;
  readonly config: McpConfig;
  readonly getMetadata: () => ReadonlyMap<string, ReadonlyArray<ToolMetadata>>;
  readonly getFailures?: () => ReadonlyMap<string, number>;
  /** Optional compatibility lifecycle facade; its health loop is scoped to the runtime. */
  readonly lifecycle?: { readonly checkConnectionsOnce: () => Promise<void> };
}

export class McpRuntimeSource extends Context.Service<McpRuntimeSource, McpRuntimeInputs>()(
  "pi-mcp-adapter/McpRuntimeSource",
) {}
