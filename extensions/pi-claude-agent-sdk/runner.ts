import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { query as sdkQuery, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeEventParser, type ClaudeAgentDetails } from "./parser.ts";

export interface ClaudeAgentInput {
	task: string;
	cwd?: string;
	model?: string;
	systemPrompt?: string;
	maxTurns?: number;
	resumeSessionId?: string;
}

export interface ClaudeAgentToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: ClaudeAgentDetails;
}

export type QueryParameters = Parameters<typeof sdkQuery>[0];
export type QueryLike = AsyncIterable<SDKMessage> & { close?: () => void };
export type QueryFactory = (parameters: QueryParameters) => QueryLike;
export type UpdateCallback = (result: ClaudeAgentToolResult) => void;

const UPDATE_INTERVAL_MS = 150;
const MAX_UPDATES = 200;
const MAX_TASK_CHARS = 200_000;

export class ClaudeAgentAbortError extends Error {
	constructor() {
		super("Claude agent invocation aborted");
		this.name = "ClaudeAgentAbortError";
	}
}

async function validatedCwd(baseCwd: string, requested?: string): Promise<string> {
	const cwd = resolve(baseCwd, requested ?? ".");
	let info;
	try {
		await access(cwd);
		info = await stat(cwd);
	} catch {
		throw new Error(`Claude agent cwd does not exist or is inaccessible: ${cwd}`);
	}
	if (!info.isDirectory()) throw new Error(`Claude agent cwd is not a directory: ${cwd}`);
	return cwd;
}

function validateInput(input: ClaudeAgentInput): void {
	if (!input.task.trim()) throw new Error("Claude agent task must not be empty");
	if (input.task.length > MAX_TASK_CHARS) throw new Error(`Claude agent task exceeds ${MAX_TASK_CHARS} characters`);
	if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 100)) {
		throw new Error("Claude agent maxTurns must be an integer from 1 to 100");
	}
	if (input.resumeSessionId !== undefined) {
		const sessionId = input.resumeSessionId.trim();
		if (!sessionId) throw new Error("Claude agent resumeSessionId must not be empty");
		if (sessionId.length > 256) throw new Error("Claude agent resumeSessionId exceeds 256 characters");
	}
}

export class ClaudeAgentRunner {
	private active?: { abort: () => void };

	constructor(private readonly queryFactory: QueryFactory) {}

	interrupt(): void {
		this.active?.abort();
	}

	async run(
		input: ClaudeAgentInput,
		baseCwd: string,
		signal?: AbortSignal,
		onUpdate?: UpdateCallback,
	): Promise<ClaudeAgentToolResult> {
		if (this.active) throw new Error("A claude invocation is already running; invocations are serialized");
		validateInput(input);

		const controller = new AbortController();
		let sdkQuery: QueryLike | undefined;
		const closeQuery = () => {
			try {
				sdkQuery?.close?.();
			} catch {
				// Abort/close is best-effort cleanup; preserve the invocation's real outcome.
			}
		};
		const abort = () => {
			controller.abort();
			closeQuery();
		};
		// Reserve the single invocation slot before the first await.
		this.active = { abort };
		const onAbort = () => abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			if (signal?.aborted) throw new ClaudeAgentAbortError();
			const cwd = await validatedCwd(baseCwd, input.cwd);
			if (signal?.aborted || controller.signal.aborted) throw new ClaudeAgentAbortError();
			const options: Options = {
				abortController: controller,
				cwd,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				includePartialMessages: true,
				persistSession: true,
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					...(input.systemPrompt?.trim() ? { append: input.systemPrompt.trim() } : {}),
				},
				...(input.model ? { model: input.model } : {}),
				...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
				...(input.resumeSessionId ? { resume: input.resumeSessionId.trim() } : {}),
			};
			sdkQuery = this.queryFactory({ prompt: input.task, options });
			const parser = new ClaudeEventParser();
			let lastUpdate = 0;
			let updateCount = 0;

			for await (const message of sdkQuery) {
				if (signal?.aborted || controller.signal.aborted) throw new ClaudeAgentAbortError();
				parser.ingest(message);
				const now = Date.now();
				if (onUpdate && updateCount < MAX_UPDATES && now - lastUpdate >= UPDATE_INTERVAL_MS) {
					const details = parser.progressDetails();
					onUpdate({ content: [{ type: "text", text: details.output || "Claude agent is working…" }], details });
					lastUpdate = now;
					updateCount++;
				}
			}

			if (signal?.aborted || controller.signal.aborted) throw new ClaudeAgentAbortError();
			const finished = parser.finish();
			return { content: [{ type: "text", text: finished.output }], details: finished.details };
		} catch (error) {
			if (signal?.aborted || controller.signal.aborted) throw new ClaudeAgentAbortError();
			throw error instanceof Error ? error : new Error(String(error));
		} finally {
			signal?.removeEventListener("abort", onAbort);
			closeQuery();
			this.active = undefined;
		}
	}
}

// Compile-time check that the SDK Query remains compatible with the injected boundary.
const _queryCompatibility: QueryLike | undefined = undefined as Query | undefined;
void _queryCompatibility;
