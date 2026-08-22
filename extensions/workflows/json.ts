/**
 * JSON decoding used at every workflow boundary: sandbox IPC payloads, tool
 * arguments, and persisted run artifacts. Values are decoded once here and flow
 * onwards as `JsonValue` instead of being re-inspected at each use site.
 */

import { z } from "zod";
import type { JsonValue } from "../shared/subagent.ts";

/** A JSON object: the only JSON value with named members. */
export type JsonMembers = { readonly [key: string]: JsonValue };

/** Decoder for any JSON document. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A decoded JSON value is a scalar, an array, or an object; the first two are
 * decided without touching members, so what remains has named members.
 */
export function isJsonMembers(value: JsonValue): value is JsonMembers {
  return !Array.isArray(value) && !jsonScalarSchema.safeParse(value).success;
}

/** The text a JSON value carries, or `undefined` when it is not a JSON string. */
export function jsonText(value: JsonValue): string | undefined {
  const decoded = z.string().safeParse(value);
  return decoded.success ? decoded.data : undefined;
}
