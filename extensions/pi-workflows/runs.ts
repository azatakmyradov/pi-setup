export const MAX_CONCURRENT_AGENTS = 8;
export const MAX_TOTAL_AGENTS = 200;

export type RunStatus = "running" | "done" | "error" | "aborted";
export type AgentStatus = "pending" | "running" | "done" | "error" | "aborted";

export interface AgentRecord {
	id: number;
	label: string;
	prompt: string;
	model?: string;
	status: AgentStatus;
	activity?: string;
	tokens: number;
	cost: number;
	output?: string;
	/** Actual value returned by agent(), including parsed schema data. */
	value?: unknown;
	cacheKey?: string;
	cached?: boolean;
	isolated?: boolean;
	lean?: boolean;
	changedFiles?: string[];
	diff?: string;
	error?: string;
	startedAt?: number;
	endedAt?: number;
	/** Runtime controls used by the live progress view. */
	abortController?: AbortController;
	restart?: () => Promise<void>;
	attempts?: number;
}

export interface WorkflowRun {
	id: number;
	name: string;
	description: string;
	script: string;
	args?: unknown;
	status: RunStatus;
	agents: AgentRecord[];
	logs: string[];
	result?: unknown;
	error?: string;
	startedAt: number;
	endedAt?: number;
	abortController: AbortController;
}

export interface RunTotals {
	total: number;
	done: number;
	running: number;
	failed: number;
	tokens: number;
	cost: number;
}

export function runTotals(run: WorkflowRun): RunTotals {
	const totals: RunTotals = { total: run.agents.length, done: 0, running: 0, failed: 0, tokens: 0, cost: 0 };
	for (const agent of run.agents) {
		if (agent.status === "done") totals.done++;
		if (agent.status === "running") totals.running++;
		if (agent.status === "error" || agent.status === "aborted") totals.failed++;
		totals.tokens += agent.tokens;
		totals.cost += agent.cost;
	}
	return totals;
}

export class Semaphore {
	private available: number;
	private waiters: Array<() => void> = [];

	constructor(count: number) {
		this.available = count;
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Agent aborted");
		if (this.available > 0) {
			this.available--;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const ready = () => {
				signal?.removeEventListener("abort", aborted);
				resolve();
			};
			const aborted = () => {
				const index = this.waiters.indexOf(ready);
				if (index >= 0) this.waiters.splice(index, 1);
				reject(new Error("Agent aborted"));
			};
			this.waiters.push(ready);
			signal?.addEventListener("abort", aborted, { once: true });
		});
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.available++;
	}
}

let nextRunId = 1;
const runs = new Map<number, WorkflowRun>();
const listeners = new Set<(run: WorkflowRun) => void>();

export function subscribeToRuns(listener: (run: WorkflowRun) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function notifyRunUpdated(run: WorkflowRun): void {
	for (const listener of listeners) listener(run);
}

export function createRun(name: string, description: string, script: string, args?: unknown): WorkflowRun {
	const run: WorkflowRun = {
		id: nextRunId++,
		name,
		description,
		script,
		args,
		status: "running",
		agents: [],
		logs: [],
		startedAt: Date.now(),
		abortController: new AbortController(),
	};
	runs.set(run.id, run);
	notifyRunUpdated(run);
	return run;
}

export interface RestorableRun {
	id: number;
	name: string;
	description: string;
	script: string;
	args?: unknown;
	status: RunStatus;
	agents: AgentRecord[];
	logs: string[];
	result?: unknown;
	error?: string;
	startedAt: number;
	endedAt?: number;
}

export function restoreRuns(restored: RestorableRun[]): void {
	for (const snapshot of restored) {
		if (runs.has(snapshot.id)) continue;
		const interrupted = snapshot.status === "running";
		const run: WorkflowRun = {
			...snapshot,
			status: interrupted ? "aborted" : snapshot.status,
			endedAt: interrupted ? Date.now() : snapshot.endedAt,
			error: interrupted ? snapshot.error ?? "Interrupted when the pi session stopped" : snapshot.error,
			agents: snapshot.agents.map((agent) => ({
				...agent,
				status: agent.status === "running" || agent.status === "pending" ? "aborted" : agent.status,
				abortController: undefined,
				restart: undefined,
			})),
			abortController: new AbortController(),
		};
		runs.set(run.id, run);
		nextRunId = Math.max(nextRunId, run.id + 1);
	}
}

export function getRun(id: number): WorkflowRun | undefined {
	return runs.get(id);
}

export function listRuns(): WorkflowRun[] {
	return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function activeRuns(): WorkflowRun[] {
	return listRuns().filter((run) => run.status === "running");
}

export function stopRun(run: WorkflowRun): void {
	if (run.status !== "running") return;
	run.status = "aborted";
	run.endedAt = Date.now();
	run.abortController.abort();
	notifyRunUpdated(run);
}

export function stopAgent(run: WorkflowRun, agent: AgentRecord): void {
	if (agent.status !== "pending" && agent.status !== "running") return;
	agent.status = "aborted";
	agent.endedAt = Date.now();
	agent.abortController?.abort();
	notifyRunUpdated(run);
}

export function restartAgent(agent: AgentRecord): Promise<void> | undefined {
	if (agent.status !== "error" && agent.status !== "aborted") return;
	return agent.restart?.();
}

export function stopAllRuns(): void {
	for (const run of runs.values()) stopRun(run);
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}
