import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect, Option, Schema } from "effect";

class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface SummaryConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "medium",
};

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const PRIVATE_CONFIG_PATH = join(extensionDirectory, "config.private.json");

/** On-disk form of config.private.json; provider/model are trimmed after decode. */
const storedSummaryConfig = Schema.fromJsonString(
  Schema.Struct({
    provider: Schema.String,
    model: Schema.String,
    reasoning: Schema.Literals(REASONING_LEVELS),
  }),
);

const decodeStoredSummaryConfig = Schema.decodeOption(storedSummaryConfig);

/**
 * Decode the raw config.private.json text. Malformed JSON, a missing field, a
 * non-string provider/model, or an unknown reasoning level all fall back to the
 * built-in defaults rather than failing the session.
 */
export function parseSummaryConfig(json: string) {
  const stored = decodeStoredSummaryConfig(json);
  if (Option.isNone(stored)) return DEFAULT_SUMMARY_CONFIG;

  const provider = stored.value.provider.trim();
  const model = stored.value.model.trim();
  if (!provider || !model) return DEFAULT_SUMMARY_CONFIG;

  return { provider, model, reasoning: stored.value.reasoning } satisfies SummaryConfig;
}

export function loadSummaryConfig() {
  try {
    return parseSummaryConfig(readFileSync(PRIVATE_CONFIG_PATH, "utf8"));
  } catch {
    return DEFAULT_SUMMARY_CONFIG;
  }
}

export function saveSummaryConfig(config: SummaryConfig, signal?: AbortSignal) {
  const tempPath = `${PRIVATE_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const write = Effect.tryPromise({
    try: async (effectSignal) => {
      await mkdir(dirname(PRIVATE_CONFIG_PATH), { recursive: true });
      try {
        await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          signal: effectSignal,
        });
        await rename(tempPath, PRIVATE_CONFIG_PATH);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    },
    catch: (cause) =>
      new ConfigWriteError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.timeout("5 seconds"));

  return Effect.runPromise(write, signal ? { signal } : undefined);
}
