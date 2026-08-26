import { existsSync } from "node:fs";
import type { McpConfig } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { getMetadataCachePath } from "./metadata-cache.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools-catalog.ts";
import { getRememberedServers } from "./project-state.ts";

export function startupPolicyRequiresRuntime(
  config: McpConfig,
  cache: MetadataCache | null,
  rememberedServers: ReadonlySet<string>,
  cacheExists: boolean,
  directToolBootstrapEnabled: boolean,
): boolean {
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) return false;
  if (!cacheExists || !cache) return true;

  if (entries.some(([name, definition]) => {
    const mode = definition.lifecycle ?? (rememberedServers.has(name) ? "keep-alive" : "lazy");
    return mode === "eager" || mode === "keep-alive";
  })) {
    return true;
  }

  return directToolBootstrapEnabled
    && getMissingConfiguredDirectToolServers(config, cache).length > 0;
}

export function shouldInitializeRuntimeAtSessionStart(
  config: McpConfig,
  cache: MetadataCache | null,
  cwd: string,
): boolean {
  return startupPolicyRequiresRuntime(
    config,
    cache,
    getRememberedServers(cwd),
    existsSync(getMetadataCachePath()),
    process.env.MCP_DIRECT_TOOLS !== "__none__",
  );
}
