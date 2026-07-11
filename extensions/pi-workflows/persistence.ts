import { createHash } from "node:crypto";

import type { AgentOptions, IsolatedAgentResult } from "./runtime.ts";
import type { AgentRecord, RunStatus, WorkflowRun } from "./runs.ts";

export const WORKFLOW_STATE_ENTRY = "pi-workflows-state-v1";
export const WORKFLOW_STATE_VERSION = 1;

export interface CachedAgentResult {
	key: string;
	output: string;
	value: unknown;
	tokens: number;
	cost: number;
	isolated?: boolean;
	changedFiles?: string[];
	diff?: string;
	completedAt: number;
}

export interface PersistedAgentRecord {
	id: number;
	label: string;
	prompt: string;
	model?: string;
	status: AgentRecord["status"];
	activity?: string;
	tokens: number;
	cost: number;
	output?: string;
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
	attempts?: number;
}

export interface PersistedWorkflowRun {
	version: 1;
	id: number;
	name: string;
	description: string;
	script: string;
	args?: unknown;
	status: RunStatus;
	agents: PersistedAgentRecord[];
	logs: string[];
	result?: unknown;
	error?: string;
	startedAt: number;
	endedAt?: number;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
	}
	return value;
}

export function agentCacheKey(prompt: string, options: AgentOptions, context: { cwd: string; model?: string; provider?: string }): string {
	const payload = stableValue({
		version: 1,
		prompt,
		cwd: context.cwd,
		model: options.model ?? context.model,
		provider: options.provider ?? (options.model ? undefined : context.provider),
		thinkingLevel: options.thinkingLevel ?? "high",
		tools: options.tools ?? null,
		schema: options.schema ?? null,
		isolated: options.isolated ?? false,
		lean: options.lean ?? false,
	});
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function serializeRun(run: WorkflowRun): PersistedWorkflowRun {
	return {
		version: WORKFLOW_STATE_VERSION,
		id: run.id,
		name: run.name,
		description: run.description,
		script: run.script,
		args: run.args,
		status: run.status,
		agents: run.agents.map(({ abortController: _abort, restart: _restart, ...agent }) => ({ ...agent })),
		logs: [...run.logs],
		result: run.result,
		error: run.error,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
	};
}

export function isPersistedWorkflowRun(value: unknown): value is PersistedWorkflowRun {
	if (!value || typeof value !== "object") return false;
	const run = value as Partial<PersistedWorkflowRun>;
	return run.version === 1 && typeof run.id === "number" && typeof run.name === "string" && typeof run.script === "string" && Array.isArray(run.agents) && Array.isArray(run.logs) && typeof run.startedAt === "number";
}

export function cachedResultFromAgent(agent: PersistedAgentRecord): CachedAgentResult | undefined {
	if (agent.status !== "done" || !agent.cacheKey || agent.output === undefined) return;
	return {
		key: agent.cacheKey,
		output: agent.output,
		value: agent.value,
		tokens: agent.tokens,
		cost: agent.cost,
		isolated: agent.isolated,
		changedFiles: agent.changedFiles,
		diff: agent.diff,
		completedAt: agent.endedAt ?? Date.now(),
	};
}

export function cachedReturnValue(result: CachedAgentResult): unknown {
	if (result.isolated) {
		return { output: result.output, diff: result.diff ?? "", changedFiles: result.changedFiles ?? [] } satisfies IsolatedAgentResult;
	}
	return result.value;
}
