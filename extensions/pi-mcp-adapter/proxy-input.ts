import { z } from "zod";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./json-value.ts";

const jsonArgKindSchema = z.union([
  z.string().transform(() => "string"),
  z.number().transform(() => "number"),
  z.boolean().transform(() => "boolean"),
  z.null().transform(() => "null"),
  z.array(jsonValueSchema).transform(() => "array"),
  jsonObjectSchema.transform(() => "object"),
]);

export function parseProxyArguments(args: string | undefined): JsonObject | undefined {
  if (!args) return undefined;

  try {
    const decoded: JsonValue = JSON.parse(args);
    const objectArgs = jsonObjectSchema.safeParse(decoded);
    if (!objectArgs.success) {
      const kind = jsonArgKindSchema.safeParse(decoded);
      throw new Error(`Invalid args: expected a JSON object, got ${kind.success ? kind.data : "unknown"}`);
    }
    return objectArgs.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }
}
