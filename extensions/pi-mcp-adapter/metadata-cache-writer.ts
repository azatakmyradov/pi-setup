import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpResource, McpTool } from "./types.ts";
import {
  getMetadataCachePath,
  loadMetadataCache,
  type CachedResource,
  type CachedTool,
  type MetadataCache,
} from "./metadata-cache.ts";
import { extractToolUiStreamMode } from "./utils.ts";
import { jsonObjectSchema, jsonValueSchema } from "./json-value.ts";

const CACHE_VERSION = 1;

export function saveMetadataCache(cache: MetadataCache): void {
  const cachePath = getMetadataCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });

  const existing = loadMetadataCache();
  const merged: MetadataCache = {
    version: CACHE_VERSION,
    servers: { ...existing?.servers, ...cache.servers },
  };

  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, cachePath);
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
  return tools
    .filter((tool) => tool?.name)
    .map((tool) => {
      const inputSchema = jsonValueSchema.safeParse(tool.inputSchema);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema.success ? inputSchema.data : undefined,
        uiResourceUri: tryGetToolUiResourceUri(tool),
        uiStreamMode: extractToolUiStreamMode(toolMetaOf(tool)),
      };
    });
}

export function serializeResources(resources: McpResource[]): CachedResource[] {
  return resources
    .filter((resource) => resource?.name && resource?.uri)
    .map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
    }));
}

function toolMetaOf(tool: McpTool) {
  const decoded = jsonObjectSchema.safeParse(tool._meta);
  return decoded.success ? decoded.data : undefined;
}

function tryGetToolUiResourceUri(tool: McpTool): string | undefined {
  try {
    return getToolUiResourceUri({ _meta: toolMetaOf(tool) });
  } catch {
    return undefined;
  }
}
