import { Type } from "typebox";
import { z } from "zod";
import type { MetadataCache } from "./metadata-cache.ts";
import {
  isServerCacheValid,
  reconstructToolMetadata,
} from "./metadata-cache.ts";
import type {
  McpCodeModeSettings,
  McpConfig,
  ToolMetadata,
} from "./types.ts";
import { jsonValueSchema, type JsonValue } from "./json-value.ts";

export const CODE_MODE_TOOL_NAME = "mcp_execute";

export const DEFAULT_CODE_MODE_SETTINGS: Required<McpCodeModeSettings> = {
  enabled: false,
  catalogBudget: 2_000,
  timeoutMs: 60_000,
  maxToolCalls: 20,
  maxOutputBytes: 50 * 1024,
};

export interface ResolvedCodeModeSettings extends Required<McpCodeModeSettings> {}

export interface CodeModeJsonSchema {
  type?: string | string[];
  enum?: JsonValue[];
  const?: JsonValue;
  anyOf?: CodeModeJsonSchema[];
  oneOf?: CodeModeJsonSchema[];
  allOf?: CodeModeJsonSchema[];
  properties?: Record<string, CodeModeJsonSchema>;
  required?: string[];
  items?: CodeModeJsonSchema;
  additionalProperties?: boolean | CodeModeJsonSchema;
  description?: string;
  default?: JsonValue;
  format?: string;
  deprecated?: boolean;
  minItems?: number;
  maxItems?: number;
  $ref?: string;
  $defs?: Record<string, CodeModeJsonSchema>;
  definitions?: Record<string, CodeModeJsonSchema>;
}

export type CodeModeMetadata = ReadonlyMap<string, ReadonlyArray<ToolMetadata>>;

export interface CodeModeSearchRequest {
  query: string;
  namespace?: string;
  limit?: number;
  offset: number;
}

export interface CodeModeSearchSummary {
  totalCount: number;
  matchCount: number;
  returnedCount: number;
}

export type CodeModeSearchNotice = (
  request: CodeModeSearchRequest,
  summary: CodeModeSearchSummary,
) => string | undefined;

const codeModeJsonSchema: z.ZodType<CodeModeJsonSchema> = z.lazy(() =>
  z.object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    enum: z.array(jsonValueSchema).optional(),
    const: jsonValueSchema.optional(),
    anyOf: z.array(codeModeJsonSchema).optional(),
    oneOf: z.array(codeModeJsonSchema).optional(),
    allOf: z.array(codeModeJsonSchema).optional(),
    properties: z.record(z.string(), codeModeJsonSchema).optional(),
    required: z.array(z.string()).optional(),
    items: codeModeJsonSchema.optional(),
    additionalProperties: z.union([z.boolean(), codeModeJsonSchema]).optional(),
    description: z.string().optional(),
    default: jsonValueSchema.optional(),
    format: z.string().optional(),
    deprecated: z.boolean().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    $ref: z.string().optional(),
    $defs: z.record(z.string(), codeModeJsonSchema).optional(),
    definitions: z.record(z.string(), codeModeJsonSchema).optional(),
  }),
);

interface CatalogTool {
  path: string;
  description: string;
  input: CodeModeJsonSchema;
  signature: string;
}

const SEARCH_SIGNATURE = `tools.$codemode.search(input: {
  query?: string,
  namespace?: string,
  limit?: number,
  offset?: number,
}): Promise<{
  items: Array<{
      path: string,
      description: string,
      signature: string,
    }>,
  remaining: number,
  next: {
      offset: number,
    } | null,
  message?: string,
}>`;

const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_RENDER_DEPTH = 8;

export function resolveCodeModeSettings(
  value: boolean | McpCodeModeSettings | undefined,
): ResolvedCodeModeSettings {
  if (value === true) return { ...DEFAULT_CODE_MODE_SETTINGS, enabled: true };
  if (!value) return DEFAULT_CODE_MODE_SETTINGS;

  return {
    enabled: value.enabled === true,
    catalogBudget: nonNegativeInt(value.catalogBudget, DEFAULT_CODE_MODE_SETTINGS.catalogBudget),
    timeoutMs: positiveInt(value.timeoutMs, DEFAULT_CODE_MODE_SETTINGS.timeoutMs),
    maxToolCalls: nonNegativeInt(value.maxToolCalls, DEFAULT_CODE_MODE_SETTINGS.maxToolCalls),
    maxOutputBytes: nonNegativeInt(value.maxOutputBytes, DEFAULT_CODE_MODE_SETTINGS.maxOutputBytes),
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function decodeCodeModeJsonSchema(value: JsonValue | undefined): CodeModeJsonSchema {
  return codeModeJsonSchema.safeParse(value).data ?? { type: "object", properties: {} };
}

function nestedCodeModeJsonSchema(
  value: boolean | CodeModeJsonSchema | undefined,
): CodeModeJsonSchema | undefined {
  return codeModeJsonSchema.safeParse(value).data;
}

export function buildCodeModeMetadataFromCache(
  config: McpConfig,
  cache: MetadataCache | null,
): Map<string, ToolMetadata[]> {
  const metadata = new Map<string, ToolMetadata[]>();
  if (!cache) return metadata;

  const prefix = config.settings?.toolPrefix ?? "server";
  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const entry = cache.servers[serverName];
    if (!entry || !isServerCacheValid(entry, definition)) continue;
    metadata.set(serverName, reconstructToolMetadata(serverName, entry, prefix, definition));
  }

  return metadata;
}

function configuredServersWithoutMetadata(
  config: McpConfig,
  metadata: CodeModeMetadata,
): string[] {
  return Object.keys(config.mcpServers).filter((serverName) => !metadata.has(serverName));
}

function formatServerList(servers: ReadonlyArray<string>): string {
  return servers.length === 1
    ? `"${servers[0]}"`
    : servers.map((server) => `"${server}"`).join(", ");
}

function reconnectHint(servers: ReadonlyArray<string>): string {
  if (servers.length === 1) return `/mcp reconnect ${servers[0]}`;
  return `/mcp reconnect <server> (for example, /mcp reconnect ${servers[0]})`;
}

export function createCodeModeSearchNotice(
  config: McpConfig,
  getMetadata: () => CodeModeMetadata,
): CodeModeSearchNotice {
  return (request, summary) => {
    if (summary.matchCount > 0) return undefined;

    const missing = configuredServersWithoutMetadata(config, getMetadata());
    const relevant = request.namespace === undefined
      ? missing
      : missing.filter((serverName) => serverName === request.namespace);
    if (relevant.length === 0) return undefined;

    const scope = request.namespace === undefined ? "" : ` for namespace "${request.namespace}"`;
    const plural = relevant.length === 1 ? "server" : "servers";
    return `No Code Mode MCP tools are known${scope} yet. Cached metadata is missing for configured ${plural}: ${formatServerList(relevant)}. Run ${reconnectHint(relevant)} or refresh the server in the MCP panel, then retry ${CODE_MODE_TOOL_NAME}.`;
  };
}

function appendPiNotes(
  instructions: string,
  config: McpConfig,
  metadata: CodeModeMetadata,
  settings: ResolvedCodeModeSettings,
): string {
  const missing = configuredServersWithoutMetadata(config, metadata);
  const notes = [
    "",
    "## Pi MCP execution notes",
    "",
    `- ${CODE_MODE_TOOL_NAME} is the only model-facing MCP tool while code mode is enabled; the normal \`mcp\` proxy and direct MCP tools are hidden. User/admin \`/mcp\`, MCP panel, auth commands, lifecycle, and metadata cache behavior remain available.`,
    "- Child calls use Pi's Effect-owned MCP runtime: lazy MCP connect, OAuth/auth handling, cancellation signals, request timeouts, elicitation, and output guards all apply.",
    `- Limits: ${settings.maxToolCalls} child calls, ${settings.timeoutMs}ms wall time, ${settings.maxOutputBytes} output bytes.`,
    "- The confined program has no ambient network, filesystem, or process access; use listed Code Mode MCP tools for external operations.",
    ...(missing.length === 0
      ? []
      : [
          `- Cached metadata is missing for configured server${missing.length === 1 ? "" : "s"}: ${formatServerList(missing)}. Search will report this; run ${reconnectHint(missing)} or refresh the MCP panel before using tools from those servers.`,
        ]),
  ];
  return `${instructions}${notes.join("\n")}`;
}

function toolExpression(path: string): string {
  return "tools" + path
    .split(".")
    .map((segment) => identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`)
    .join("");
}

function unescapePointerToken(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function renderLiteral(value: JsonValue): string {
  return JSON.stringify(value) ?? "unknown";
}

function effectNumberSentinel(schema: CodeModeJsonSchema): boolean {
  return schema.type === "string"
    && Array.isArray(schema.enum)
    && schema.enum.length === 1
    && (schema.enum[0] === "NaN" || schema.enum[0] === "Infinity" || schema.enum[0] === "-Infinity");
}

function intersection(members: ReadonlyArray<string>): string {
  const concrete = members.filter((member) => member !== "unknown");
  if (concrete.length === 0) return "unknown";
  if (concrete.length === 1) return concrete[0] ?? "unknown";
  return concrete.map((member) => member.includes(" | ") ? `(${member})` : member).join(" & ");
}

interface RenderContext {
  definitions: Readonly<Record<string, CodeModeJsonSchema>>;
  pretty: boolean;
}

function hasUnresolvedRef(
  schema: CodeModeJsonSchema,
  definitions: Readonly<Record<string, CodeModeJsonSchema>>,
  seen: ReadonlySet<string> = new Set(),
  visited: ReadonlySet<CodeModeJsonSchema> = new Set(),
): boolean {
  if (visited.has(schema)) return false;
  const nextVisited = new Set([...visited, schema]);
  if (schema.$ref !== undefined) {
    const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1];
    const name = segment === undefined ? undefined : unescapePointerToken(segment);
    if (name === undefined || definitions[name] === undefined || seen.has(name)) return true;
    if (hasUnresolvedRef(definitions[name], definitions, new Set([...seen, name]), nextVisited)) return true;
  }
  const additionalProperties = nestedCodeModeJsonSchema(schema.additionalProperties);
  return [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items === undefined ? [] : [schema.items]),
    ...(additionalProperties === undefined ? [] : [additionalProperties]),
  ].some((item) => hasUnresolvedRef(item, definitions, seen, nextVisited));
}

function docTags(schema: CodeModeJsonSchema): string[] {
  const tags: string[] = [];
  if (schema.deprecated === true) tags.push("@deprecated");
  if (schema.default !== undefined) {
    const rendered = JSON.stringify(schema.default);
    if (rendered !== undefined) tags.push(`@default ${rendered}`);
  }
  if (schema.format !== undefined) tags.push(`@format ${schema.format}`);
  if (schema.minItems !== undefined) tags.push(`@minItems ${schema.minItems}`);
  if (schema.maxItems !== undefined) tags.push(`@maxItems ${schema.maxItems}`);
  return tags;
}

function jsdoc(description: string | undefined, tags: ReadonlyArray<string>, pad: string): string {
  const lines = [...(description === undefined ? [] : description.split("\n")), ...tags]
    .map((line) => line.replaceAll("*/", "* /").replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  if (lines.length === 0) return "";
  if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`;
  const body = lines.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`).join("\n");
  return `${pad}/**\n${body}\n${pad} */\n`;
}

function renderSchema(
  schema: CodeModeJsonSchema,
  context: RenderContext,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string {
  if (depth > MAX_RENDER_DEPTH) return "unknown";
  const nested = schema.definitions === undefined && schema.$defs === undefined
    ? context
    : { ...context, definitions: { ...context.definitions, ...schema.definitions, ...schema.$defs } };

  if (schema.$ref) {
    const segment = schema.$ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/)?.[1];
    const name = segment === undefined ? undefined : unescapePointerToken(segment);
    if (!name || !nested.definitions[name] || seen.has(name)) return "unknown";
    return intersection([
      renderSchema(nested.definitions[name], nested, depth, new Set([...seen, name])),
      renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen),
    ]);
  }
  if (schema.const !== undefined) return renderLiteral(schema.const);
  if (schema.enum) return schema.enum.map(renderLiteral).join(" | ");

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    if (
      alternatives.some((item) => item.type === "number")
      && alternatives.every((item) => item.type === "number" || effectNumberSentinel(item))
    ) {
      return "number";
    }
    if (
      alternatives.length === 2
      && alternatives[0]?.type === "object"
      && alternatives[0].properties === undefined
      && alternatives[1]?.type === "array"
      && alternatives[1].items === undefined
    ) {
      return "{}";
    }
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen));
    if (members.some((member) => member === "unknown")) return "unknown";
    return intersection([
      members.join(" | "),
      renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen),
    ]);
  }
  if (schema.allOf) {
    const members = schema.allOf.map((item) => renderSchema(item, nested, depth + 1, seen));
    if (schema.allOf.some((item) => hasUnresolvedRef(item, nested.definitions))) return "unknown";
    return intersection([
      renderSchema({ ...schema, allOf: undefined }, nested, depth + 1, seen),
      ...members,
    ]);
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((item) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen)).join(" | ");
  }
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`;
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {});
    const additional = nestedCodeModeJsonSchema(schema.additionalProperties);
    const indexType = additional === undefined
      ? undefined
      : renderSchema(additional, nested, depth + 1, seen);
    const field = ([name, value]: readonly [string, CodeModeJsonSchema]) =>
      `${identifierSegment.test(name) ? name : JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}`;

    if (!context.pretty) {
      const fields = properties.map(field);
      if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`);
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }

    if (properties.length === 0 && indexType === undefined) return "{}";
    const pad = "  ".repeat(depth + 1);
    const lines = properties.map(
      (entry) => `${jsdoc(entry[1].description, docTags(entry[1]), pad)}${pad}${field(entry)},`,
    );
    if (indexType !== undefined) lines.push(`${pad}[key: string]: ${indexType},`);
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
  }
  return "unknown";
}

function catalogTools(metadata: CodeModeMetadata): CatalogTool[] {
  const tools: CatalogTool[] = [];
  for (const [server, entries] of metadata) {
    if (server === "$codemode") continue;
    const byName = new Map<string, ToolMetadata>();
    for (const tool of entries) {
      if (!tool.uiResourceUri) byName.set(tool.originalName, tool);
    }
    for (const tool of byName.values()) {
      const input = decodeCodeModeJsonSchema(tool.inputSchema);
      const path = `${server}.${tool.originalName}`;
      tools.push({
        path,
        description: tool.description || `(MCP tool ${server}/${tool.originalName})`,
        input,
        signature: `${toolExpression(path)}(input: ${renderSchema(input, { definitions: {}, pretty: true })}): Promise<unknown>`,
      });
    }
  }
  return tools;
}

function catalogLine(tool: CatalogTool): string {
  const line = tool.description.split("\n", 1)[0]!.trim();
  const description = line.length > 120 ? `${line.slice(0, 119)}...` : line;
  return description === "" ? `  - ${tool.signature}` : `  - ${tool.signature} // ${description}`;
}

function estimateTokens(input: string): number {
  return Math.max(0, Math.round(input.length / 4));
}

function catalogInstructions(metadata: CodeModeMetadata, catalogBudget: number): string {
  if (!Number.isSafeInteger(catalogBudget) || catalogBudget < 0) {
    throw new RangeError("discovery.catalogBudget must be a non-negative safe integer");
  }

  const described = catalogTools(metadata);
  const namespaces = new Map<string, CatalogTool[]>();
  for (const tool of described) {
    const [namespace = tool.path] = tool.path.split(".");
    const group = namespaces.get(namespace) ?? [];
    group.push(tool);
    namespaces.set(namespace, group);
  }
  const ordered = [...namespaces].sort(([left], [right]) => left.localeCompare(right));
  const selections = ordered.map(([namespace, group]) => ({
    namespace,
    picked: new Set<CatalogTool>(),
    queue: [...group].sort(
      (left, right) => estimateTokens(catalogLine(left)) - estimateTokens(catalogLine(right))
        || left.path.localeCompare(right.path),
    ),
  }));
  let used = 0;
  let active = selections.filter((selection) => selection.queue.length > 0);
  while (active.length > 0) {
    const stillActive: typeof active = [];
    for (const selection of active) {
      const tool = selection.queue[0]!;
      const cost = estimateTokens(catalogLine(tool));
      if (used + cost > catalogBudget) continue;
      selection.queue.shift();
      selection.picked.add(tool);
      used += cost;
      if (selection.queue.length > 0) stillActive.push(selection);
    }
    active = stillActive;
  }
  const shown = new Map<string, ReadonlySet<CatalogTool>>(
    selections.map(({ namespace, picked }) => [namespace, picked]),
  );
  const totalShown = selections.reduce((total, { picked }) => total + picked.size, 0);
  const complete = totalShown === described.length;
  const empty = described.length === 0;

  const intro = [
    empty
      ? "This is a restricted JavaScript language for calling tools, not a general-purpose runtime."
      : complete
        ? "This is a restricted JavaScript language for calling tools, not a general-purpose runtime. Inside the confined interpreter, `tools` contains the Code Mode tools listed below and internal runtime tools; surrounding agent tools are not available."
        : "This is a restricted JavaScript language for calling tools, not a general-purpose runtime. Inside the confined interpreter, `tools` contains the Code Mode tools listed or searchable below and internal runtime tools; surrounding agent tools are not available.",
    ...(empty
      ? []
      : ["Do not infer or normalize tool names; use only exact signatures shown below or returned by search."]),
  ];
  const workflow = [
    "",
    "## Workflow",
    "",
    ...(empty
      ? [
          '1. Discover known cached tools: `return await tools.$codemode.search({ query: "<intent + key nouns>" })`.',
          "2. If search returns no items, refresh MCP metadata outside Code Mode and try again.",
        ]
      : complete
        ? [
            "1. Pick a tool from the list under `## Available tools` - each line is the exact call signature; use it as-is rather than guessing segments, or use `tools.$codemode.search` to look it up again.",
            "2. Call it using the exact signature shown: `const result = await tools.<namespace>.<tool>(input)`; bracket notation and quotes are part of the path.",
            "3. Return only the fields you need from structured results; narrow unknown results before reading fields, and avoid returning large raw payloads.",
          ]
        : [
            '1. If needed, discover tools: `return await tools.$codemode.search({ query: "<intent + key nouns>" })`.',
            "2. In the next execution, copy a returned path exactly, call it, and return only the needed fields.",
          ]),
  ];
  const rules = [
    "",
    "## Rules",
    "",
    ...(empty
      ? [
          "- Only internal runtime tools such as `tools.$codemode.search` are available until MCP metadata is cached; surrounding agent tools are not implicitly exposed.",
          "- Do not fabricate tool names from server names. Refresh MCP metadata when search reports that no tools are known yet.",
        ]
      : [
          complete
            ? "- Only Code Mode tools listed here and internal runtime tools are available; surrounding agent tools are not implicitly exposed."
            : "- Only Code Mode tools listed here or returned by `tools.$codemode.search` and internal runtime tools are available; surrounding agent tools are not implicitly exposed.",
          "- `tools.$codemode.search` is always callable and returns complete callable signatures, even when the catalog above is complete.",
          "- Filter, aggregate, and transform collections in code - never return them raw or call a tool per item across messages.",
          "- A result typed `Promise<unknown>` may be structured data or text. Before reading fields, check that it is a non-null object and not an array; otherwise handle the returned text or primitive directly.",
          '- Run independent calls in parallel: `await Promise.all(items.map((item) => tools.<namespace>.<tool>(item)))`, or use `tools.<namespace>["tool-name"](item)` when the listed signature uses bracket notation.',
          "- `Object.keys(tools)` lists namespaces; `Object.keys(tools.<namespace>)` lists its tools; `for...in` works on both.",
          '- Browse one namespace: `await tools.$codemode.search({ query: "", namespace: "<name>" })`.',
          "- If search returns `next`, repeat the same search with `offset: next.offset`.",
        ]),
  ];
  const language = [
    "",
    "## Language",
    "",
    "Use common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Built-ins include Date, RegExp, Map, Set, URL, URLSearchParams, and URI encoding helpers.",
    "Modules/imports, classes, generators, timers, fetch, eval, prototype access, unlisted methods, and promise chaining are unavailable. Use Code Mode tools for external operations. Use await with try/catch.",
    "Dates and URLs serialize to strings at data boundaries; Map/Set/RegExp/URLSearchParams serialize to `{}`.",
  ];
  const toolSection: string[] = [""];
  if (empty) {
    toolSection.push(
      "## Available tools",
      "",
      "No Code Mode tools are currently available from cached metadata.",
      "",
      "Internal discovery tool:",
      `- ${SEARCH_SIGNATURE}`,
    );
  } else {
    toolSection.push(
      complete
        ? "## Available tools (COMPLETE list - every tool is shown below with its full call signature)"
        : `## Available tools (PARTIAL - ${totalShown} of ${described.length} shown; find the rest with tools.$codemode.search)`,
      "",
    );
    for (const [namespace, group] of ordered) {
      const picked = shown.get(namespace)!;
      const count = `${group.length} tool${group.length === 1 ? "" : "s"}`;
      const label = picked.size === group.length
        ? count
        : picked.size === 0
          ? `${count}, none shown`
          : `${count}, ${picked.size} shown`;
      toolSection.push(`- ${namespace} (${label})`);
      for (const tool of group) {
        if (picked.has(tool)) toolSection.push(catalogLine(tool));
      }
    }
    toolSection.push("", "Search returns complete callable signatures:", `- ${SEARCH_SIGNATURE}`);
  }

  return [...intro, ...workflow, ...rules, ...language, ...toolSection].join("\n");
}

export function codeModeToolDescription(
  config: McpConfig,
  metadata: CodeModeMetadata,
): string {
  const settings = resolveCodeModeSettings(config.settings?.codeMode);
  return appendPiNotes(
    catalogInstructions(metadata, settings.catalogBudget),
    config,
    metadata,
    settings,
  );
}

export function codeModeToolParameters() {
  return Type.Object({
    code: Type.String({
      description:
        "Confined JavaScript program. Use await tools.<server>.<tool>(input) and return only the fields needed.",
    }),
  });
}
