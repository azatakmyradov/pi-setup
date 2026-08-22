import { spawn } from "node:child_process";
import { z } from "zod";

export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];

export interface SubagentProgress {
  kind: "tool" | "turn";
  activity: string;
  tokens: number;
  cost: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every value JSON can carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** A JSON Schema document handed to the subagent as its output contract. */
export type SubagentOutputSchema = Record<string, JsonValue>;

export interface SubagentRequest {
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  provider?: string;
  tools?: string[];
  lean?: boolean;
  schema?: SubagentOutputSchema;
  onProgress?: (progress: SubagentProgress) => void;
}

export interface SubagentResult {
  text: string;
  data?: unknown;
  tokens: number;
  cost: number;
  turns: number;
}

/**
 * `pi --mode json` writes one JSON event per line. Every field is decoded
 * defensively: a field the CLI reports in an unexpected form degrades to
 * `undefined` instead of discarding the whole event.
 */
const contentBlockSchema = z
  .object({
    type: z.string().optional().catch(undefined),
    text: z.string().optional().catch(undefined),
  })
  .catch({});

const usageSchema = z.object({
  totalTokens: z.number().optional().catch(undefined),
  cost: z
    .object({ total: z.number().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const assistantMessageSchema = z.object({
  role: z.string().optional().catch(undefined),
  content: z.array(contentBlockSchema).optional().catch(undefined),
  usage: usageSchema.optional().catch(undefined),
  stopReason: z.string().optional().catch(undefined),
  errorMessage: z.string().optional().catch(undefined),
});

type AssistantMessage = z.infer<typeof assistantMessageSchema>;

/** The tool arguments worth showing in a progress line. */
const toolCallArgumentsSchema = z.object({
  path: z.string().optional().catch(undefined),
  file_path: z.string().optional().catch(undefined),
  command: z.string().optional().catch(undefined),
  pattern: z.string().optional().catch(undefined),
});

type ToolCallArguments = z.infer<typeof toolCallArgumentsSchema>;

const streamEventSchema = z.object({
  type: z.string().optional().catch(undefined),
  message: assistantMessageSchema.optional().catch(undefined),
  toolName: z.string().optional().catch(undefined),
  args: toolCallArgumentsSchema.optional().catch(undefined),
});

type SubagentStreamEvent = z.infer<typeof streamEventSchema>;

const MAX_PROMPT_CHARS = 200_000;

export class SubagentSchemaError extends Error {
  constructor(
    message: string,
    public readonly output: string,
  ) {
    super(message);
    this.name = "SubagentSchemaError";
  }
}

export class SubagentProviderError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "SubagentProviderError";
  }
}

export function isTransientProviderError(message: string): boolean {
  return /(?:\b429\b|\b50[0234]\b|rate.?limit|overload|temporar(?:y|ily)|unavailable|ECONNRESET|ETIMEDOUT|network timeout|connection reset)/i.test(
    message,
  );
}

function schemaInstruction(schema: SubagentOutputSchema): string {
  return [
    "",
    "---",
    "Respond with ONLY a single JSON value matching this JSON schema, with no prose before or after it.",
    "You may wrap it in a ```json code fence.",
    `Schema: ${JSON.stringify(schema)}`,
  ].join("\n");
}

/** Decode one JSON document, or `undefined` when the text is not JSON. */
function decodeJson(text: string): JsonValue | undefined {
  try {
    const decoded = jsonValueSchema.safeParse(JSON.parse(text));
    return decoded.success ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

export function extractJson(text: string): JsonValue {
  const trimmed = text.trim();
  const whole = decodeJson(trimmed);
  if (whole !== undefined) return whole;
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fence?.[1]) {
    const fenced = decodeJson(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }
  const start = trimmed.search(/[[{]/);
  if (start !== -1) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      const embedded = decodeJson(trimmed.slice(start, end + 1));
      if (embedded !== undefined) return embedded;
    }
  }
  throw new SubagentSchemaError(
    `Subagent did not return valid JSON. Output was:\n${text.slice(0, 2000)}`,
    text.slice(0, 4000),
  );
}

function messageText(message: AssistantMessage): string {
  return (message.content ?? [])
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n\n");
}

export function buildSubagentArgs(
  request: SubagentRequest,
  prompt: string,
  tools: string[],
): string[] {
  const args = ["-p", "--mode", "json", "--no-session", "-t", tools.join(",")];
  if (request.lean) {
    args.push("--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates");
  }
  if (request.provider) args.push("--provider", request.provider);
  if (request.model) args.push("--model", request.model);
  args.push("--thinking", request.thinkingLevel ?? "high");
  args.push(prompt);
  return args;
}

function describeToolCall(toolName: string, args: ToolCallArguments | undefined): string {
  const detail = args?.path ?? args?.file_path ?? args?.command ?? args?.pattern;
  if (detail !== undefined && detail !== "") {
    return `${toolName} ${detail.length > 60 ? `${detail.slice(0, 60)}…` : detail}`;
  }
  return toolName;
}

export async function runSubagent(request: SubagentRequest): Promise<SubagentResult> {
  if (request.signal.aborted) throw new Error("Subagent aborted");
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `Subagent prompt too long (${request.prompt.length} chars, max ${MAX_PROMPT_CHARS})`,
    );
  }
  const prompt = request.schema
    ? request.prompt + schemaInstruction(request.schema)
    : request.prompt;
  const tools = request.tools?.length ? request.tools : DEFAULT_SUBAGENT_TOOLS;
  const args = buildSubagentArgs(request, prompt, tools);

  return new Promise<SubagentResult>((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stdoutBuffer = "";
    let stderrTail = "";
    let lastAssistant: AssistantMessage | undefined;
    let tokens = 0;
    let cost = 0;
    let turns = 0;
    const onAbort = () => child.kill("SIGTERM");
    request.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      fn();
    };

    const handleEvent = (event: SubagentStreamEvent) => {
      switch (event.type) {
        case "message_end": {
          const message = event.message;
          if (message?.role === "assistant") {
            lastAssistant = message;
            tokens += message.usage?.totalTokens ?? 0;
            cost += message.usage?.cost?.total ?? 0;
            request.onProgress?.({ kind: "turn", activity: "thinking", tokens, cost });
          }
          break;
        }
        case "turn_start":
          turns++;
          break;
        case "tool_execution_start": {
          const activity = describeToolCall(event.toolName ?? "tool", event.args);
          request.onProgress?.({ kind: "tool", activity, tokens, cost });
          break;
        }
      }
    };

    /** Progress reporting must never break the stream, so failures stay swallowed. */
    const handleLine = (line: string) => {
      try {
        const event = streamEventSchema.safeParse(JSON.parse(line));
        if (event.success) handleEvent(event.data);
      } catch {}
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) handleLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });

    child.on("error", (error) => {
      finish(() =>
        reject(
          new SubagentProviderError(
            `Failed to launch pi subagent: ${error.message}`,
            isTransientProviderError(error.message),
          ),
        ),
      );
    });

    child.on("close", (code) => {
      finish(() => {
        const rest = stdoutBuffer.trim();
        if (rest) handleLine(rest);
        if (request.signal.aborted) {
          reject(new Error("Subagent aborted"));
          return;
        }
        if (!lastAssistant) {
          const message = `Subagent produced no assistant response (exit code ${code}).${stderrTail ? `\nstderr: ${stderrTail}` : ""}`;
          reject(new SubagentProviderError(message, isTransientProviderError(message)));
          return;
        }
        if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
          const message =
            lastAssistant.errorMessage || `Subagent request ${lastAssistant.stopReason}`;
          reject(new SubagentProviderError(message, isTransientProviderError(message)));
          return;
        }
        const text = messageText(lastAssistant);
        try {
          const data = request.schema ? extractJson(text) : undefined;
          resolve({ text, data, tokens, cost, turns });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  });
}
