import { spawn } from "node:child_process";

export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];

export interface SubagentProgress {
	kind: "tool" | "turn";
	activity: string;
	tokens: number;
	cost: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SubagentRequest {
	prompt: string;
	cwd: string;
	signal: AbortSignal;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	provider?: string;
	tools?: string[];
	lean?: boolean;
	schema?: Record<string, unknown>;
	onProgress?: (progress: SubagentProgress) => void;
}

export interface SubagentResult {
	text: string;
	data?: unknown;
	tokens: number;
	cost: number;
	turns: number;
}

interface UsageLike {
	totalTokens?: number;
	cost?: { total?: number };
}

interface AssistantMessageLike {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	usage?: UsageLike;
	stopReason?: string;
	errorMessage?: string;
}

const MAX_PROMPT_CHARS = 200_000;
export class SubagentSchemaError extends Error {
	constructor(message: string, public readonly output: string) {
		super(message);
		this.name = "SubagentSchemaError";
	}
}

export class SubagentProviderError extends Error {
	constructor(message: string, public readonly transient: boolean) {
		super(message);
		this.name = "SubagentProviderError";
	}
}

export function isTransientProviderError(message: string): boolean {
	return /(?:\b429\b|\b50[0234]\b|rate.?limit|overload|temporar(?:y|ily)|unavailable|ECONNRESET|ETIMEDOUT|network timeout|connection reset)/i.test(message);
}

function schemaInstruction(schema: Record<string, unknown>): string {
	return [
		"",
		"---",
		"Respond with ONLY a single JSON value matching this JSON schema, with no prose before or after it.",
		"You may wrap it in a ```json code fence.",
		`Schema: ${JSON.stringify(schema)}`,
	].join("\n");
}

export function extractJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {}
	const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
	if (fence?.[1]) {
		try {
			return JSON.parse(fence[1].trim());
		} catch {}
	}
	const start = trimmed.search(/[[{]/);
	if (start !== -1) {
		const open = trimmed[start];
		const close = open === "{" ? "}" : "]";
		const end = trimmed.lastIndexOf(close);
		if (end > start) {
			try {
				return JSON.parse(trimmed.slice(start, end + 1));
			} catch {}
		}
	}
	throw new SubagentSchemaError(`Subagent did not return valid JSON. Output was:\n${text.slice(0, 2000)}`, text.slice(0, 4000));
}

function messageText(message: AssistantMessageLike): string {
	return (message.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n\n");
}

export function buildSubagentArgs(request: SubagentRequest, prompt: string, tools: string[]): string[] {
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

function describeToolCall(toolName: string, args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		const detail = record.path ?? record.file_path ?? record.command ?? record.pattern ?? "";
		if (typeof detail === "string" && detail) {
			return `${toolName} ${detail.length > 60 ? `${detail.slice(0, 60)}…` : detail}`;
		}
	}
	return toolName;
}

export async function runSubagent(request: SubagentRequest): Promise<SubagentResult> {
	if (request.signal.aborted) throw new Error("Workflow aborted");
	if (request.prompt.length > MAX_PROMPT_CHARS) {
		throw new Error(`Subagent prompt too long (${request.prompt.length} chars, max ${MAX_PROMPT_CHARS})`);
	}
	const prompt = request.schema ? request.prompt + schemaInstruction(request.schema) : request.prompt;
	const tools = request.tools?.length ? request.tools : DEFAULT_SUBAGENT_TOOLS;

	const args = buildSubagentArgs(request, prompt, tools);

	return new Promise<SubagentResult>((resolve, reject) => {
		const child = spawn("pi", args, {
			cwd: request.cwd,
			env: { ...process.env, PI_WORKFLOWS_SUBAGENT: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let settled = false;
		let stdoutBuffer = "";
		let stderrTail = "";
		let lastAssistant: AssistantMessageLike | undefined;
		let tokens = 0;
		let cost = 0;
		let turns = 0;
		const onAbort = () => {
			child.kill("SIGTERM");
		};
		request.signal.addEventListener("abort", onAbort, { once: true });

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			request.signal.removeEventListener("abort", onAbort);
			fn();
		};

		const handleEvent = (event: Record<string, unknown>) => {
			switch (event.type) {
				case "message_end": {
					const message = event.message as AssistantMessageLike | undefined;
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
					const activity = describeToolCall(String(event.toolName ?? "tool"), event.args);
					request.onProgress?.({ kind: "tool", activity, tokens, cost });
					break;
				}
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			let newlineIndex = stdoutBuffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = stdoutBuffer.slice(0, newlineIndex).trim();
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				if (line) {
					try {
						handleEvent(JSON.parse(line) as Record<string, unknown>);
					} catch {}
				}
				newlineIndex = stdoutBuffer.indexOf("\n");
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
		});

		child.on("error", (error) => {
			finish(() => reject(new SubagentProviderError(`Failed to launch pi subagent: ${error.message}`, isTransientProviderError(error.message))));
		});

		child.on("close", (code) => {
			finish(() => {
				// The final event may arrive without a trailing newline; parse the leftover buffer.
				const rest = stdoutBuffer.trim();
				if (rest) {
					try {
						handleEvent(JSON.parse(rest) as Record<string, unknown>);
					} catch {}
				}
				if (request.signal.aborted) {
					reject(new Error("Workflow aborted"));
					return;
				}
				if (!lastAssistant) {
					const message = `Subagent produced no assistant response (exit code ${code}).${stderrTail ? `\nstderr: ${stderrTail}` : ""}`;
					reject(new SubagentProviderError(message, isTransientProviderError(message)));
					return;
				}
				if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
					const message = lastAssistant.errorMessage || `Subagent request ${lastAssistant.stopReason}`;
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
