import { Context, Effect, Layer } from "effect";
import type { McpConfig, ToolMetadata } from "../types.ts";
import { InvalidToolArgumentsError, SearchError, type CatalogEntry, type SearchQuery, type ToolRef } from "./domain.ts";
import { McpRuntimeSource } from "./runtime-source.ts";

export interface CatalogServiceApi {
  readonly entries: Effect.Effect<ReadonlyArray<CatalogEntry>>;
  readonly search: (query: SearchQuery) => Effect.Effect<ReadonlyArray<CatalogEntry>, SearchError>;
  readonly describe: (ref: ToolRef) => Effect.Effect<CatalogEntry, InvalidToolArgumentsError>;
  readonly resolve: (ref: ToolRef) => Effect.Effect<CatalogEntry, InvalidToolArgumentsError>;
}

export class CatalogService extends Context.Service<
  CatalogService,
  CatalogServiceApi
>()("pi-mcp-adapter/CatalogService") {}

export interface CatalogSource {
  readonly getMetadata: () => ReadonlyMap<string, ReadonlyArray<ToolMetadata>>;
  readonly config: McpConfig;
}

function allEntries(source: CatalogSource): ReadonlyArray<CatalogEntry> {
  const result: CatalogEntry[] = [];
  for (const [server, metadata] of source.getMetadata()) {
    if (!source.config.mcpServers[server]) continue;
    for (const tool of metadata) {
      result.push({ server, tool });
    }
  }
  return result;
}

function makeSearchPattern(query: SearchQuery): RegExp | SearchError {
  const text = query.query.trim();
  if (text.length === 0) {
    return new SearchError({ message: "Search query cannot be empty" });
  }

  if (query.regex) {
    if (text.length > 256) {
      return new SearchError({
        message: "Regex query is too long; maximum length is 256 characters.",
      });
    }
    try {
      return new RegExp(text, "i");
    } catch {
      return new SearchError({ message: `Invalid regex: ${query.query}` });
    }
  }

  const escaped = text
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "i");
}

function catalogService(source: CatalogSource): CatalogServiceApi {
  return CatalogService.of({
    entries: Effect.sync(() => allEntries(source)),
    search: (query) => Effect.suspend(() => {
      const pattern = makeSearchPattern(query);
      if (pattern instanceof SearchError) return Effect.fail(pattern);

      return Effect.succeed(allEntries(source).filter(({ server, tool }) => {
        if (query.server && query.server !== server) return false;
        return pattern.test(tool.name) || pattern.test(tool.description);
      }));
    }),
    describe: (ref) => Effect.suspend(() => {
      const matches = allEntries(source).filter(({ server, tool }) => {
        if (ref.server && ref.server !== server) return false;
        return tool.name === ref.name || tool.originalName === ref.name;
      });
      if (matches.length === 0) {
        return Effect.fail(new InvalidToolArgumentsError({
          message: `Tool "${ref.name}" was not found in the MCP metadata catalog.`,
          server: ref.server,
          tool: ref.name,
        }));
      }
      if (matches.length > 1 && !ref.server) {
        return Effect.fail(new InvalidToolArgumentsError({
          message: `Tool "${ref.name}" is ambiguous; specify a server.`,
          tool: ref.name,
        }));
      }
      return Effect.succeed(matches[0]);
    }),
    resolve: (ref) => Effect.suspend(() => {
      const matches = allEntries(source).filter(({ server, tool }) => {
        if (ref.server && ref.server !== server) return false;
        return tool.name === ref.name || tool.originalName === ref.name;
      });
      if (matches.length === 0) {
        return Effect.fail(new InvalidToolArgumentsError({
          message: `Tool "${ref.name}" was not found in the MCP metadata catalog.`,
          server: ref.server,
          tool: ref.name,
        }));
      }
      if (matches.length > 1 && !ref.server) {
        return Effect.fail(new InvalidToolArgumentsError({
          message: `Tool "${ref.name}" is ambiguous; specify a server.`,
          tool: ref.name,
        }));
      }
      return Effect.succeed(matches[0]);
    }),
  });
}

/** The tool-catalog capability, reading its metadata view from the runtime source. */
export const catalogLayer: Layer.Layer<CatalogService, never, McpRuntimeSource> = Layer.effect(
  CatalogService,
  Effect.gen(function* () {
    const { config, getMetadata } = yield* McpRuntimeSource;
    return catalogService({ config, getMetadata });
  }),
);
