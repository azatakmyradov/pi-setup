import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpTool, McpResource, ServerEntry } from "./types.ts";
import { formatToolName, isToolExcluded } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolUiStreamMode } from "./utils.ts";
import {
  asJsonObject,
  asJsonText,
  asJsonTextList,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./json-value.ts";

/** What one metadata build produced: the usable tools plus the tools that could not be described. */
export interface ToolMetadataBuild {
  metadata: ToolMetadata[];
  failedTools: string[];
}

export function buildToolMetadata(
  tools: McpTool[],
  resources: McpResource[],
  definition: ServerEntry,
  serverName: string,
  prefix: "server" | "none" | "short"
): ToolMetadataBuild {
  const metadata: ToolMetadata[] = [];
  const failedTools: string[] = [];

  for (const tool of tools) {
    if (!tool?.name) {
      failedTools.push("(unnamed)");
      continue;
    }
    if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) {
      continue;
    }

    // Decode the server-supplied `_meta` bag and JSON Schema once, at the SDK boundary.
    const decodedMeta = jsonObjectSchema.safeParse(tool._meta);
    const toolMeta = decodedMeta.success ? decodedMeta.data : undefined;
    const inputSchema = jsonValueSchema.safeParse(tool.inputSchema);

    let uiResourceUri: string | undefined;
    try {
      uiResourceUri = getToolUiResourceUri({ _meta: toolMeta });
    } catch {
      failedTools.push(tool.name);
    }
    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: inputSchema.success ? inputSchema.data : undefined,
      uiResourceUri,
      uiStreamMode: extractToolUiStreamMode(toolMeta),
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of resources) {
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

  return { metadata, failedTools };
}

export function getToolNames(state: McpExtensionState, serverName: string): string[] {
  return state.toolMetadata.get(serverName)?.map(m => m.name) ?? [];
}

export function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += metadata.length;
  }
  return count;
}

export function findToolByName(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
  if (!metadata) return undefined;
  const exact = metadata.find(m => m.name === toolName);
  if (exact) return exact;
  const normalized = toolName.replace(/-/g, "_");
  return metadata.find(m => m.name.replace(/-/g, "_") === normalized);
}

export function formatSchema(schema: JsonValue | undefined, indent = "  "): string {
  const s = asJsonObject(schema);
  if (s === undefined) {
    return `${indent}(no schema)`;
  }

  const props = asJsonObject(s.properties);
  if (s.type === "object" && props !== undefined) {
    const required = asJsonTextList(s.required);

    if (Object.keys(props).length === 0) {
      return `${indent}(no parameters)`;
    }

    const lines: string[] = [];
    for (const [name, propSchema] of Object.entries(props)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
    return lines.join("\n");
  }

  const lines = formatNestedSchema(s, indent);
  if (lines.length > 0) {
    return lines.join("\n");
  }

  const typeStr = formatType(s);
  if (typeStr) {
    return `${indent}(${typeStr})`;
  }

  return `${indent}(complex schema)`;
}

function formatProperty(name: string, schema: JsonValue | undefined, required: boolean, indent: string): string[] {
  const s = asJsonObject(schema);
  if (s === undefined) {
    return [`${indent}${name}${required ? " *required*" : ""}`];
  }

  const parts = [`${indent}${name}`];
  const typeStr = formatType(s);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");
  appendSchemaAnnotations(parts, s);

  return [parts.join(" "), ...formatNestedSchema(s, `${indent}  `)];
}

function formatNestedSchema(schema: JsonObject, indent: string): string[] {
  const lines: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    lines.push(...formatVariants("anyOf", schema.anyOf, indent));
  }
  if (Array.isArray(schema.oneOf)) {
    lines.push(...formatVariants("oneOf", schema.oneOf, indent));
  }
  if (schema.items !== undefined) {
    lines.push(...formatProperty("items", schema.items, false, indent));
  }
  const properties = asJsonObject(schema.properties);
  if (properties !== undefined) {
    const required = asJsonTextList(schema.required);
    for (const [name, propSchema] of Object.entries(properties)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
  }

  return lines;
}

function formatVariants(keyword: "anyOf" | "oneOf", variants: JsonValue[], indent: string): string[] {
  const lines = [`${indent}${keyword}:`];

  for (const variant of variants) {
    const s = asJsonObject(variant);
    if (s === undefined) {
      lines.push(`${indent}  - ${JSON.stringify(variant)}`);
      continue;
    }

    const typeStr = formatType(s) || "schema";
    const parts = [`${indent}  - ${typeStr}`];
    appendSchemaAnnotations(parts, s);
    lines.push(parts.join(" "));
    lines.push(...formatNestedSchema(s, `${indent}    `));
  }

  return lines;
}

function formatType(schema: JsonObject): string {
  if (Object.hasOwn(schema, "const")) {
    return `const ${JSON.stringify(schema.const)}`;
  }

  if (Array.isArray(schema.enum)) {
    return `enum: ${schema.enum.map(v => JSON.stringify(v)).join(", ")}`;
  }

  if (Array.isArray(schema.type)) {
    return asJsonTextList(schema.type).join(" | ");
  }

  const typeName = asJsonText(schema.type);
  if (typeName !== undefined) {
    return typeName;
  }

  if (asJsonObject(schema.properties) !== undefined) {
    return "object";
  }

  if (schema.items !== undefined) {
    return "array";
  }

  return "";
}

function appendSchemaAnnotations(parts: string[], schema: JsonObject): void {
  const description = asJsonText(schema.description);
  if (description) {
    parts.push(`- ${description}`);
  }

  for (const key of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "format", "pattern"] as const) {
    if (schema[key] !== undefined) {
      parts.push(`[${key}: ${JSON.stringify(schema[key])}]`);
    }
  }

  if (schema.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(schema.default)}]`);
  }
}
