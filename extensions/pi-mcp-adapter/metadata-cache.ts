// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { createHash } from "node:crypto";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpTool, McpResource, ServerEntry, ToolMetadata } from "./types.ts";
import { formatToolName, isToolExcluded } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolUiStreamMode, interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./utils.ts";
import { z } from "zod";
import {
  isJsonObject,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "./json-value.ts";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  uiResourceUri?: string;
  uiStreamMode?: "eager" | "stream-first";
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

const cachedToolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: jsonValueSchema.optional(),
  uiResourceUri: z.string().optional(),
  uiStreamMode: z.enum(["eager", "stream-first"]).optional(),
});

const cachedResourceSchema = z.looseObject({
  uri: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

const serverCacheEntrySchema = z.looseObject({
  configHash: z.string(),
  tools: z.array(cachedToolSchema).default([]),
  resources: z.array(cachedResourceSchema).default([]),
  cachedAt: z.number(),
});

/**
 * Decodes the persisted cache document. The adapter owns this file, so an entry that no
 * longer matches the current form makes the whole document unreadable and metadata is
 * rediscovered — the same outcome as a version bump.
 */
const metadataCacheSchema = z.looseObject({
  version: z.number(),
  servers: z.record(z.string(), serverCacheEntrySchema),
});

export function getMetadataCachePath(): string {
  return getAgentPath("mcp-cache.json");
}

export function loadMetadataCache(): MetadataCache | null {
  const cachePath = getMetadataCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const cache = metadataCacheSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf-8")));
    if (!cache.success) return null;
    if (cache.data.version !== CACHE_VERSION) return null;
    return { version: CACHE_VERSION, servers: cache.data.servers };
  } catch {
    return null;
  }
}

export function saveMetadataCache(cache: MetadataCache): void {
  const cachePath = getMetadataCachePath();
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true });

  let merged: MetadataCache = { version: CACHE_VERSION, servers: {} };
  try {
    if (existsSync(cachePath)) {
      const existing = metadataCacheSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf-8")));
      if (existing.success && existing.data.version === CACHE_VERSION) {
        merged.servers = { ...existing.data.servers };
      }
    }
  } catch {
    // Ignore parse errors and proceed with empty cache
  }

  merged.version = CACHE_VERSION;
  merged.servers = { ...merged.servers, ...cache.servers };

  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, cachePath);
}

export function computeServerHash(definition: ServerEntry): string {
  // Hash only fields that affect server identity and tool/resource output.
  // Exclude lifecycle, idleTimeout, requestTimeoutMs, debug — those are runtime behavior settings
  // that don't change which tools a server exposes.
  const identity = {
    command: definition.command,
    args: definition.args,
    env: interpolateEnvRecord(definition.env),
    cwd: resolveConfigPath(definition.cwd),
    url: definition.url,
    headers: interpolateEnvRecord(definition.headers),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    excludeTools: definition.excludeTools,
  };
  const normalized = stableStringify(identity);
  return createHash("sha256").update(normalized).digest("hex");
}

export function isServerCacheValid(
  entry: ServerCacheEntry,
  definition: ServerEntry,
  maxAgeMs: number = CACHE_MAX_AGE_MS
): boolean {
  if (!entry || entry.configHash !== computeServerHash(definition)) return false;
  if (!entry.cachedAt || !Number.isFinite(entry.cachedAt)) return false;
  if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
  return true;
}

export function reconstructToolMetadata(
  serverName: string,
  entry: ServerCacheEntry,
  prefix: "server" | "none" | "short",
  definition: Pick<ServerEntry, "exposeResources" | "excludeTools">
): ToolMetadata[] {
  const metadata: ToolMetadata[] = [];

  for (const tool of entry.tools ?? []) {
    if (!tool?.name) continue;
    if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) {
      continue;
    }

    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      uiResourceUri: tool.uiResourceUri,
      uiStreamMode: tool.uiStreamMode,
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of entry.resources ?? []) {
      if (!resource?.name || !resource?.uri) continue;
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
      if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) {
        continue;
      }

      metadata.push({
        name: formatToolName(baseName, serverName, prefix),
        originalName: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }

  return metadata;
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
  return tools
    .filter(t => t?.name)
    .map(t => {
      // Decode the server-supplied JSON Schema so the cache only ever holds JSON.
      const inputSchema = jsonValueSchema.safeParse(t.inputSchema);
      return {
        name: t.name,
        description: t.description,
        inputSchema: inputSchema.success ? inputSchema.data : undefined,
        uiResourceUri: tryGetToolUiResourceUri(t),
        uiStreamMode: extractToolUiStreamMode(toolMetaOf(t)),
      };
    });
}

export function serializeResources(resources: McpResource[]): CachedResource[] {
  return resources
    .filter(r => r?.name && r?.uri)
    .map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
    }));
}

function stableStringify(value: JsonValue | undefined): string {
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

/** Decode the server-supplied `_meta` bag once, at the MCP SDK boundary. */
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
