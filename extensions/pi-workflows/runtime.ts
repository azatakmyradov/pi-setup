import { MAX_CONCURRENT_AGENTS, MAX_TOTAL_AGENTS, notifyRunUpdated, Semaphore } from "./runs.ts";
import type { AgentRecord, WorkflowRun } from "./runs.ts";
import {
	isTransientProviderError,
	runSubagent,
	SubagentProviderError,
	SubagentSchemaError,
} from "./subagent.ts";
import type { SubagentRequest, SubagentResult, ThinkingLevel } from "./subagent.ts";
import { applyWorktreePatch, createTemporaryWorktree } from "./worktree.ts";
import type { TemporaryWorktree } from "./worktree.ts";
import { agentCacheKey, cachedReturnValue } from "./persistence.ts";
import type { CachedAgentResult } from "./persistence.ts";

export interface AgentOptions {
	label?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	schema?: Record<string, unknown>;
	isolated?: boolean;
	lean?: boolean;
}

export interface IsolatedAgentResult {
	output: string;
	diff: string;
	changedFiles: string[];
}

export type SubagentRunner = (request: SubagentRequest) => Promise<SubagentResult>;

export interface ExecuteWorkflowOptions {
	cwd: string;
	args?: unknown;
	defaultModel?: { provider: string; id: string };
	runAgent?: SubagentRunner;
	onUpdate?: (run: WorkflowRun) => void;
	retryDelayMs?: number;
	cache?: {
		get(key: string): CachedAgentResult | undefined;
		put(key: string, result: CachedAgentResult): void;
	};
	onCheckpoint?: (run: WorkflowRun) => void;
}

export function transformScript(source: string): string {
	return source
		.replace(/^(\s*)export\s+default\s+/gm, "$1")
		.replace(/^(\s*)export\s+(?=(?:const|let|var|function|async|class)\b)/gm, "$1");
}

function promptLabel(prompt: string): string {
	const firstLine = prompt.trim().split("\n", 1)[0] ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error("Workflow aborted"));
		const timer = setTimeout(done, ms);
		function done() {
			signal.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted() {
			clearTimeout(timer);
			signal.removeEventListener("abort", aborted);
			reject(new Error("Workflow aborted"));
		}
		signal.addEventListener("abort", aborted, { once: true });
	});
}

function schemaRepairPrompt(originalPrompt: string, error: SubagentSchemaError): string {
	return `${originalPrompt}\n\n---\nYour previous response was invalid JSON. Correct it and return ONLY the JSON value.\nParse error: ${error.message}\nPrevious response:\n${error.output}`;
}

export async function executeWorkflow(run: WorkflowRun, options: ExecuteWorkflowOptions): Promise<unknown> {
	const runAgent = options.runAgent ?? runSubagent;
	const semaphore = new Semaphore(MAX_CONCURRENT_AGENTS);
	const notify = () => {
		notifyRunUpdated(run);
		options.onUpdate?.(run);
	};

	const agent = async (prompt: unknown, agentOptions: AgentOptions = {}): Promise<unknown> => {
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new Error("agent(prompt, options?) requires a non-empty string prompt");
		}
		if (run.abortController.signal.aborted) throw new Error("Workflow aborted");
		if (agentOptions.isolated && agentOptions.schema) {
			throw new Error("agent() cannot combine isolated: true with schema");
		}
		if (run.agents.length >= MAX_TOTAL_AGENTS) {
			throw new Error(`Agent cap reached (${MAX_TOTAL_AGENTS} agents per run)`);
		}

		const effectiveModel = agentOptions.model ?? options.defaultModel?.id;
		const effectiveProvider = agentOptions.provider ?? (agentOptions.model ? undefined : options.defaultModel?.provider);
		const cacheKey = agentCacheKey(prompt, agentOptions, {
			cwd: options.cwd,
			model: effectiveModel,
			provider: effectiveProvider,
		});
		const agentAbortController = new AbortController();
		const signal = AbortSignal.any([run.abortController.signal, agentAbortController.signal]);
		const record: AgentRecord = {
			id: run.agents.length + 1,
			label: agentOptions.label ?? promptLabel(prompt),
			prompt,
			model: agentOptions.model ?? (options.defaultModel ? `${options.defaultModel.provider}/${options.defaultModel.id}` : undefined),
			status: "pending",
			tokens: 0,
			cost: 0,
			isolated: agentOptions.isolated,
			lean: agentOptions.lean,
			cacheKey,
			abortController: agentAbortController,
			attempts: 1,
		};
		record.restart = async () => {
			if (run.abortController.signal.aborted) throw new Error("A stopped run cannot restart agents");
			await agent(prompt, agentOptions);
			run.logs.push(`agent ${record.id}: re-run succeeded; resume the run (u) to rebuild the report`);
			notify();
		};
		run.agents.push(record);
		notify();

		const cached = options.cache?.get(cacheKey);
		if (cached) {
			record.status = "done";
			record.cached = true;
			record.output = cached.output;
			record.value = cached.value;
			record.tokens = cached.tokens;
			record.cost = cached.cost;
			record.isolated = cached.isolated;
			record.changedFiles = cached.changedFiles;
			record.diff = cached.diff;
			record.startedAt = record.endedAt = Date.now();
			run.logs.push(`agent ${record.id}: cache hit`);
			notify();
			options.onCheckpoint?.(run);
			return cachedReturnValue(cached);
		}

		try {
			await semaphore.acquire(signal);
		} catch (error) {
			record.status = "aborted";
			record.endedAt = Date.now();
			record.error = error instanceof Error ? error.message : String(error);
			notify();
			throw error;
		}
		let worktree: TemporaryWorktree | undefined;
		try {
			if (run.abortController.signal.aborted) {
				record.status = "aborted";
				throw new Error("Workflow aborted");
			}
			record.status = "running";
			record.startedAt = Date.now();
			if (agentOptions.isolated) {
				record.activity = "creating isolated worktree";
				notify();
				worktree = await createTemporaryWorktree(options.cwd, signal);
			}
			notify();

			const model = effectiveModel;
			const provider = effectiveProvider;

			let attemptPrompt = prompt;
			let schemaRetried = false;
			let transientRetried = false;
			let result!: SubagentResult;
			while (true) {
				try {
					result = await runAgent({
						prompt: attemptPrompt,
						cwd: worktree?.cwd ?? options.cwd,
						signal,
						model,
						provider,
						thinkingLevel: agentOptions.thinkingLevel ?? "high",
						tools: agentOptions.tools,
						lean: agentOptions.lean,
						schema: agentOptions.schema,
						onProgress: (progress) => {
							record.activity = progress.activity;
							record.tokens = progress.tokens;
							record.cost = progress.cost;
							notify();
						},
					});
					break;
				} catch (error) {
					if (agentOptions.schema && error instanceof SubagentSchemaError && !schemaRetried) {
						schemaRetried = true;
						record.attempts = (record.attempts ?? 1) + 1;
						attemptPrompt = schemaRepairPrompt(prompt, error);
						record.activity = "repairing invalid JSON";
						run.logs.push(`agent ${record.id}: retrying invalid JSON response`);
						notify();
						continue;
					}
					const transient = error instanceof SubagentProviderError
						? error.transient
						: error instanceof Error && isTransientProviderError(error.message);
					if (transient && !transientRetried) {
						transientRetried = true;
						record.attempts = (record.attempts ?? 1) + 1;
						record.activity = "retrying provider error";
						run.logs.push(`agent ${record.id}: retrying transient provider error`);
						notify();
						await waitForRetry(options.retryDelayMs ?? 1_000, signal);
						continue;
					}
					throw error;
				}
			}

			record.status = "done";
			record.endedAt = Date.now();
			record.tokens = result.tokens;
			record.cost = result.cost;
			record.output = result.text;
			record.value = agentOptions.schema ? result.data : result.text;
			if (worktree) {
				record.activity = "capturing isolated changes";
				const changes = await worktree.captureChanges();
				record.diff = changes.diff;
				record.changedFiles = changes.changedFiles;
				const value = { output: result.text, ...changes } satisfies IsolatedAgentResult;
				options.cache?.put(cacheKey, {
					key: cacheKey, output: result.text, value, tokens: result.tokens, cost: result.cost,
					isolated: true, changedFiles: changes.changedFiles, diff: changes.diff, completedAt: record.endedAt,
				});
				notify();
				options.onCheckpoint?.(run);
				return value;
			}
			options.cache?.put(cacheKey, {
				key: cacheKey, output: result.text, value: record.value, tokens: result.tokens, cost: result.cost, completedAt: record.endedAt,
			});
			notify();
			options.onCheckpoint?.(run);
			return record.value;
		} catch (error) {
			record.status = signal.aborted ? "aborted" : "error";
			record.endedAt = Date.now();
			record.error = error instanceof Error ? error.message : String(error);
			notify();
			options.onCheckpoint?.(run);
			throw error;
		} finally {
			if (worktree) {
				try {
					await worktree.cleanup();
				} catch (error) {
					run.logs.push(`agent ${record.id}: worktree cleanup failed (${worktree.path}): ${error instanceof Error ? error.message : String(error)}`);
					notify();
				}
			}
			semaphore.release();
		}
	};

	const pipeline = async <T, R>(items: unknown, fn: (item: T, index: number) => Promise<R> | R): Promise<(R | null)[]> => {
		if (!Array.isArray(items)) throw new Error("pipeline(items, fn) requires an array");
		if (typeof fn !== "function") throw new Error("pipeline(items, fn) requires a function");
		return Promise.all(
			items.map(async (item: T, index: number) => {
				try {
					return await fn(item, index);
				} catch (error) {
					if (run.abortController.signal.aborted) throw error;
					run.logs.push(`pipeline item ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
					notify();
					return null;
				}
			}),
		);
	};

	const log = (message: unknown): void => {
		run.logs.push(String(message));
		notify();
	};

	// git apply --index takes the repository index lock, so concurrent apply() calls must be serialized.
	let applyChain: Promise<void> = Promise.resolve();
	const apply = async (diff: unknown): Promise<void> => {
		if (typeof diff !== "string") throw new Error("apply(diff) requires a Git patch string");
		const task = applyChain.then(() => applyWorktreePatch(options.cwd, diff, run.abortController.signal));
		applyChain = task.then(
			() => undefined,
			() => undefined,
		);
		await task;
		run.logs.push("applied isolated-agent patch");
		notify();
	};

	const body = transformScript(run.script);
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
		...params: string[]
	) => (...fnArgs: unknown[]) => Promise<unknown>;

	let fn: (...fnArgs: unknown[]) => Promise<unknown>;
	try {
		fn = new AsyncFunction("agent", "pipeline", "log", "apply", "args", `"use strict";\n${body}`);
	} catch (error) {
		throw new Error(`Workflow script has a syntax error: ${error instanceof Error ? error.message : String(error)}`);
	}

	return fn(agent, pipeline, log, apply, options.args);
}
