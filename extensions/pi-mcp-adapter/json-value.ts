/**
 * The JSON domain shared by every I/O boundary in the adapter.
 *
 * MCP config files, JSON Schemas, MCP `_meta` bags, tool payloads and the
 * adapter's own state files all arrive as JSON documents. Decoding them into
 * these types once, at the boundary they enter through, gives every downstream
 * consumer a real value contract instead of an untyped escape hatch.
 */
import { z } from "zod";

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** A JSON object: string keys, JSON values. Absent keys read as `undefined`. */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** Any value that survives a round trip through a JSON document. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

/** Decodes any JSON value, at any depth. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema.optional()),
  ]),
);

/** Decodes a JSON object. Arrays, scalars, `null` and `undefined` are rejected. */
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema.optional(),
);

/** Decodes a JSON string. */
export const jsonTextSchema = z.string();

/** Read a JSON value as an object. Arrays, scalars and absent values read as absent. */
export function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Narrow a JSON value to an object in place, without copying it. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return jsonObjectSchema.safeParse(value).success;
}

/** Read a JSON value as text. Anything that is not a JSON string reads as absent. */
export function asJsonText(value: JsonValue | undefined): string | undefined {
  const parsed = jsonTextSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Read a JSON value as a list of strings, keeping only the members that are strings. */
export function asJsonTextList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = asJsonText(entry);
    return text === undefined ? [] : [text];
  });
}
