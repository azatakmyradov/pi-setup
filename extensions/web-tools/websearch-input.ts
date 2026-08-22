import { z } from "zod";
import { err, ok, type Result } from "./result.ts";
import {
  SEARCH_DEPTHS,
  SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_SECONDS,
  clampInteger,
  toToolInputParseError,
  type ToolInputParseError,
} from "./settings.ts";
import {
  parseSearchQuery,
  type JsonValue,
  type ParseSearchQueryError,
  type SearchDepth,
  type SearchQuery,
  type WebToolsSettings,
} from "./types.ts";

export interface WebSearchToolInput {
  readonly query: SearchQuery;
  readonly maxResults: number;
  readonly depth: SearchDepth;
  readonly timeoutSeconds: number;
}

/** The websearch arguments the model may send; extra keys are rejected. */
const webSearchArgumentsSchema = z.strictObject({
  query: z.string(),
  maxResults: z.number().optional(),
  depth: z.enum(SEARCH_DEPTHS).optional(),
});

/** The accepted websearch arguments, exactly as the schema decodes them. */
export type RawWebSearchToolParams = z.infer<typeof webSearchArgumentsSchema>;

const WEB_SEARCH_FIELD_MESSAGES = {
  query: "Expected a string",
  maxResults: "Expected a finite number",
  depth: "Expected one of: auto, fast, deep",
} as const;

/** Parse raw Pi websearch params into service-facing input. */
export function parseWebSearchToolParams(
  raw: JsonValue,
  settings: WebToolsSettings["search"],
): Result<WebSearchToolInput, ToolInputParseError | ParseSearchQueryError> {
  const decoded = webSearchArgumentsSchema.safeParse(raw);
  if (!decoded.success) {
    return err(toToolInputParseError(decoded.error, WEB_SEARCH_FIELD_MESSAGES));
  }

  const query = parseSearchQuery(decoded.data.query);
  if (query._tag === "err") {
    return query;
  }

  const maxResults = clampInteger(decoded.data.maxResults ?? settings.defaultMaxResults, {
    min: SEARCH_MAX_RESULTS.min,
    max: SEARCH_MAX_RESULTS.max,
    fallback: SEARCH_MAX_RESULTS.default,
  });
  const depth = decoded.data.depth ?? settings.defaultDepth;
  const timeoutSeconds = clampInteger(settings.timeoutSeconds, {
    min: SEARCH_TIMEOUT_SECONDS.min,
    max: SEARCH_TIMEOUT_SECONDS.max,
    fallback: SEARCH_TIMEOUT_SECONDS.default,
  });

  return ok({ query: query.value, maxResults, depth, timeoutSeconds });
}
