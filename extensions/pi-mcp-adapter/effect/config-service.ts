import { Context, Effect, Layer } from "effect";
import type { McpConfig, ServerDefinition } from "../types.ts";

export interface McpConfigServiceShape {
  readonly config: McpConfig;
  readonly getServer: (name: string) => Effect.Effect<ServerDefinition | undefined>;
  readonly names: Effect.Effect<ReadonlyArray<string>>;
}

/** Immutable configuration capability used by the Effect services. */
export class McpConfigService extends Context.Service<
  McpConfigService,
  McpConfigServiceShape
>()("pi-mcp-adapter/McpConfigService") {}

export function makeConfigLayer(config: McpConfig): Layer.Layer<McpConfigService> {
  return Layer.succeed(McpConfigService, McpConfigService.of({
    config,
    getServer: (name) => Effect.sync(() => config.mcpServers[name]),
    names: Effect.sync(() => Object.keys(config.mcpServers)),
  }));
}
