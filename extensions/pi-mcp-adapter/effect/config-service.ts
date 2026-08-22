import { Context, Effect, Layer } from "effect";
import type { McpConfig, ServerDefinition } from "../types.ts";
import { McpRuntimeSource } from "./runtime-source.ts";

export interface McpConfigServiceApi {
  readonly config: McpConfig;
  readonly getServer: (name: string) => Effect.Effect<ServerDefinition | undefined>;
  readonly names: Effect.Effect<ReadonlyArray<string>>;
}

/** Immutable configuration capability used by the Effect services. */
export class McpConfigService extends Context.Service<
  McpConfigService,
  McpConfigServiceApi
>()("pi-mcp-adapter/McpConfigService") {}

/** The configuration capability, reading the session config from the runtime source. */
export const mcpConfigLayer: Layer.Layer<McpConfigService, never, McpRuntimeSource> = Layer.effect(
  McpConfigService,
  Effect.gen(function* () {
    const { config } = yield* McpRuntimeSource;
    return McpConfigService.of({
      config,
      getServer: (name) => Effect.sync(() => config.mcpServers[name]),
      names: Effect.sync(() => Object.keys(config.mcpServers)),
    });
  }),
);
