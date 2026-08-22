import { z } from "zod";
import { err, ok, type Result } from "./result.ts";
import {
  FETCH_TIMEOUT_SECONDS,
  WEB_FETCH_FORMATS,
  clampInteger,
  toToolInputParseError,
  type ToolInputParseError,
} from "./settings.ts";
import {
  parsePublicHttpUrl,
  type JsonValue,
  type ParsePublicHttpUrlError,
  type PublicHttpUrl,
  type WebFetchFormat,
  type WebToolsSettings,
} from "./types.ts";

export interface WebFetchToolInput {
  readonly url: PublicHttpUrl;
  readonly format: WebFetchFormat;
  readonly timeoutSeconds: number;
}

/** The webfetch arguments the model may send; extra keys are rejected. */
const webFetchArgumentsSchema = z.strictObject({
  url: z.string(),
  format: z.enum(WEB_FETCH_FORMATS).optional(),
  timeout: z.number().optional(),
});

/** The accepted webfetch arguments, exactly as the schema decodes them. */
export type RawWebFetchToolParams = z.infer<typeof webFetchArgumentsSchema>;

const WEB_FETCH_FIELD_MESSAGES = {
  url: "Expected a string",
  format: "Expected one of: markdown, text, html",
  timeout: "Expected a finite number",
} as const;

/** Parse raw Pi webfetch params into service-facing input. */
export function parseWebFetchToolParams(
  raw: JsonValue,
  settings: WebToolsSettings["fetch"],
): Result<WebFetchToolInput, ToolInputParseError | ParsePublicHttpUrlError> {
  const decoded = webFetchArgumentsSchema.safeParse(raw);
  if (!decoded.success) {
    return err(toToolInputParseError(decoded.error, WEB_FETCH_FIELD_MESSAGES));
  }

  const url = parsePublicHttpUrl(decoded.data.url);
  if (url._tag === "err") {
    return url;
  }

  const format = decoded.data.format ?? settings.defaultFormat;
  const timeoutSeconds = clampInteger(decoded.data.timeout ?? settings.timeoutSeconds, {
    min: FETCH_TIMEOUT_SECONDS.min,
    max: FETCH_TIMEOUT_SECONDS.max,
    fallback: FETCH_TIMEOUT_SECONDS.default,
  });

  return ok({ url: url.value, format, timeoutSeconds });
}
