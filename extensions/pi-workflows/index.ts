import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { mentionsWorkflow } from "./eligibility.ts";
import { executeWorkflow } from "./runtime.ts";
import {
	activeRuns,
	createRun,
	formatDuration,
	formatTokens,
	listRuns,
	MAX_CONCURRENT_AGENTS,
	MAX_TOTAL_AGENTS,
	restoreRuns,
	runTotals,
	stopAllRuns,
	stopRun,
	subscribeToRuns,
} from "./runs.ts";
import type { WorkflowRun } from "./runs.ts";
import {
	cachedResultFromAgent,
	isPersistedWorkflowRun,
	serializeRun,
	WORKFLOW_STATE_ENTRY,
} from "./persistence.ts";
import type { CachedAgentResult, PersistedWorkflowRun } from "./persistence.ts";
import {
	deleteSavedWorkflow,
	discoverSavedWorkflows,
	parseWorkflowArgs,
	savedWorkflowStatus,
	saveWorkflowFile,
	serializeSavedWorkflow,
	validateWorkflowName,
} from "./saved-workflows.ts";
import type { WorkflowScope } from "./saved-workflows.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { WorkflowEditor } from "./workflow-editor.ts";
import { progressBar, spinnerFrame, WorkflowProgressView } from "./progress-view.ts";

const MAX_REPORT_CHARS = 30_000;
const CHECKPOINT_DEBOUNCE_MS = 2_000;
const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BUNDLED_WORKFLOWS_DIRECTORY = join(EXTENSION_DIRECTORY, "workflows");
const WORKFLOW_AUTHORING_GUIDANCE = ["workflow-authoring.md", "patterns.md"]
	.map((name) => readFileSync(join(EXTENSION_DIRECTORY, "guidance", name), "utf8").trim())
	.join("\n\n");

const SCRIPT_API_DOCS = `Design and run a JavaScript orchestration graph of pi subagents, returning one final result. Call this tool only when the current user message explicitly contains the word "workflows". Otherwise, do not call it, even for tasks that would benefit from parallel subagents.

Before writing the script, reason about the task and provide the structured plan argument. Agents must represent independent reasoning roles or coherent work units—not automatically one agent per file, URL, claim, test, or discovered item. Use the smallest useful agent count, explain why fan-out is beneficial, and prefer adaptive discovery followed by bounded semantic grouping.

Script API (the body runs as an async function; top-level await and return work):
- await agent(prompt, options?) -> string
  Spawns one subagent (a fresh headless pi). Returns its final text response.
  options:
    label?: string       short name shown in progress UI
    model?: string       "provider/model-id" (defaults to the session model)
    thinkingLevel?: string  "off", "minimal", "low", "medium", "high", "xhigh", or "max" (default: "high")
    tools?: string[]     tool allowlist. DEFAULT IS READ-ONLY: ["read","grep","find","ls"].
                         Pass ["read","edit","write","bash","grep","find","ls"] when the agent must change files or run commands.
    schema?: object      JSON schema. The agent is instructed to reply with matching JSON,
                         and agent() returns the parsed value instead of text.
    lean?: boolean       Skip extensions, skills, context files, and prompt templates. Use for
                         simple, self-contained fan-out; the agent will not receive AGENTS.md guidance.
    isolated?: boolean   Run in a temporary detached Git worktree. Returns
                         { output, diff, changedFiles }; cannot be combined with schema.
- await apply(diff)      Apply an isolated agent's patch to the original checkout with git apply --3way.
- await pipeline(items, async (item, index) => ...) -> array
  Runs the callback for every item concurrently (subagent concurrency is capped at ${MAX_CONCURRENT_AGENTS}).
  A failed item resolves to null instead of aborting the run, so filter results with .filter(Boolean).
- log(message)           progress note shown to the user
- args                   input value passed at invocation time (undefined unless provided)
- return <value>         the script's return value becomes the workflow result delivered to the conversation

Rules:
- Subagents are isolated pi processes: no shared memory, no conversation context. Every prompt must be fully self-contained (include file paths, code excerpts, and exact instructions).
- The script itself has no fs/shell/network access; only subagents touch the system.
- Hard caps: ${MAX_CONCURRENT_AGENTS} concurrent subagents, ${MAX_TOTAL_AGENTS} per run.
- Keep result payloads small: have subagents return findings, not full file contents.
- When this tool is authorized, turn-scoped authoring guidance supplies complete orchestration patterns.

Example:
  const architecture = await agent('Analyze the objective. Return at most four coherent reasoning units grouped by semantics, dependency, or risk—not by file.', {
    schema: { type: 'object', required: ['units'], properties: { units: { type: 'array', maxItems: 4, items: { type: 'object' } } } },
  })
  const analyses = await pipeline(architecture.units.slice(0, 4), (unit, index) =>
    agent(\`Investigate this coherent unit and return compact evidence: \${JSON.stringify(unit)}\`, { label: \`unit-\${index + 1}\` }),
  )
  return await agent(\`Integrate these results and check the original completion criteria: \${JSON.stringify(analyses.filter(Boolean))}\`, { label: 'integrate' })`;

const WorkflowPlanParams = Type.Object({
	objective: Type.String({ description: "The outcome this workflow must achieve" }),
	decomposition: Type.String({ description: "Why these reasoning stages and boundaries fit the task better than item-per-agent fan-out" }),
	stages: Type.Array(
		Type.Object({
			name: Type.String(),
			purpose: Type.String(),
			mode: StringEnum(["sequential", "parallel", "adaptive"] as const),
			maxAgents: Type.Integer({ minimum: 1, maximum: 32 }),
		}),
		{ minItems: 1, maxItems: 12, description: "Ordered reasoning stages and their bounded parallelism" },
	),
	fanoutRationale: Type.String({ description: "What work is genuinely independent and why separate agents improve it; say none if no fan-out is needed" }),
	expectedAgents: Type.Integer({ minimum: 1, maximum: 32 }),
	completionCriteria: Type.Array(Type.String(), { minItems: 1, maxItems: 12 }),
	stopConditions: Type.Array(Type.String(), { minItems: 1, maxItems: 12 }),
});

type WorkflowPlan = Static<typeof WorkflowPlanParams>;

const WorkflowParams = Type.Object({
	name: Type.String({ description: "Short kebab-case workflow name, e.g. audit-routes" }),
	description: Type.String({ description: "One sentence describing what the workflow does" }),
	plan: WorkflowPlanParams,
	script: Type.String({ description: "JavaScript compiled from the plan; keep all dynamic fan-out explicitly bounded" }),
});

function buildReport(run: WorkflowRun): string {
	const totals = runTotals(run);
	const duration = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
	const lines: string[] = [];
	const statusWord = run.status === "done" ? "finished" : run.status === "aborted" ? "was stopped" : "failed";
	lines.push(
		`Workflow "${run.name}" (run ${run.id}) ${statusWord} after ${duration}: ${totals.done}/${totals.total} agents succeeded` +
			(totals.failed ? `, ${totals.failed} failed` : "") +
			` · ${formatTokens(totals.tokens)} tokens` +
			(totals.cost ? ` · $${totals.cost.toFixed(4)}` : ""),
	);
	if (run.error) {
		lines.push("", `Error: ${run.error}`);
	}
	if (run.logs.length) {
		lines.push("", "Log:", ...run.logs.slice(-20).map((entry) => `  - ${entry}`));
	}
	if (run.result !== undefined) {
		const rendered = typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2);
		lines.push("", "Result:", rendered);
	}
	let report = lines.join("\n");
	if (report.length > MAX_REPORT_CHARS) {
		report = `${report.slice(0, MAX_REPORT_CHARS)}\n… (result truncated at ${MAX_REPORT_CHARS} chars)`;
	}
	return report;
}

function statusLine(): string | undefined {
	const running = activeRuns();
	if (!running.length) return undefined;
	return running
		.map((run) => {
			const totals = runTotals(run);
			const failed = totals.failed ? ` ✖${totals.failed}` : "";
			return `${spinnerFrame()} ${run.name} ${progressBar(totals.done, totals.total, 8)} ${totals.done}/${totals.total}${failed} · ${formatTokens(totals.tokens)} tok`;
		})
		.join("  ");
}

function agentGlyph(status: string): string {
	switch (status) {
		case "done":
			return "✔";
		case "error":
			return "✖";
		case "aborted":
			return "■";
		case "running":
			return "▶";
		default:
			return "·";
	}
}

export default function workflowsExtension(pi: ExtensionAPI) {
	if (process.env.PI_WORKFLOWS_SUBAGENT) return;

	let uiCtx: ExtensionContext | undefined;
	let workflowEditor: WorkflowEditor | undefined;
	let currentTurnAllowsWorkflow = false;
	let hasPendingUserInput = false;
	const agentCache = new Map<string, CachedAgentResult>();
	let persistenceEnabled = false;
	let statusTimer: ReturnType<typeof setInterval> | undefined;

	const checkpointTimers = new Map<number, ReturnType<typeof setTimeout>>();

	const persistRun = (run: WorkflowRun) => {
		const timer = checkpointTimers.get(run.id);
		if (timer) {
			clearTimeout(timer);
			checkpointTimers.delete(run.id);
		}
		if (persistenceEnabled) pi.appendEntry(WORKFLOW_STATE_ENTRY, serializeRun(run));
	};

	// Checkpoints fire per completed agent but each one appends a full run snapshot,
	// so writing them all would grow the session file quadratically. Coalesce instead;
	// terminal states still persist immediately through persistRun.
	const checkpointRun = (run: WorkflowRun) => {
		if (checkpointTimers.has(run.id)) return;
		checkpointTimers.set(
			run.id,
			setTimeout(() => {
				checkpointTimers.delete(run.id);
				persistRun(run);
			}, CHECKPOINT_DEBOUNCE_MS),
		);
	};

	const setWorkflowToolActive = (active: boolean) => {
		const activeTools = pi.getActiveTools();
		const isActive = activeTools.includes("workflow");
		if (active === isActive) return;
		pi.setActiveTools(active ? [...activeTools, "workflow"] : activeTools.filter((name) => name !== "workflow"));
	};

	pi.on("input", (event) => {
		// Use the raw current message, before skill/template expansion. Earlier mentions never carry forward.
		currentTurnAllowsWorkflow = event.source !== "extension" && mentionsWorkflow(event.text);
		hasPendingUserInput = true;
		setWorkflowToolActive(currentTurnAllowsWorkflow);
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		// Turns without a direct input event (for example workflow-result delivery) are never authorized.
		if (!hasPendingUserInput) currentTurnAllowsWorkflow = false;
		hasPendingUserInput = false;
		setWorkflowToolActive(currentTurnAllowsWorkflow);
		if (currentTurnAllowsWorkflow) {
			return { systemPrompt: `${event.systemPrompt}\n\n${WORKFLOW_AUTHORING_GUIDANCE}` };
		}
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "workflow" && !currentTurnAllowsWorkflow) {
			return {
				block: true,
				reason: 'The workflow tool requires the current user message to mention "workflows".',
			};
		}
	});

	const refreshStatus = () => {
		uiCtx?.ui.setStatus("workflows", statusLine());
	};

	const deliverReport = (run: WorkflowRun) => {
		pi.sendMessage(
			{
				customType: "workflow-result",
				content: buildReport(run),
				display: true,
				details: { runId: run.id, name: run.name, status: run.status },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	const launchRun = async (run: WorkflowRun, ctx: ExtensionContext, args?: unknown): Promise<void> => {
		try {
			const result = await executeWorkflow(run, {
				cwd: ctx.cwd,
				defaultModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				args,
				onUpdate: refreshStatus,
				cache: {
					get: (key) => agentCache.get(key),
					put: (key, result) => agentCache.set(key, result),
				},
				onCheckpoint: checkpointRun,
			});
			if (run.status === "running") {
				run.status = "done";
				run.result = result;
				run.endedAt = Date.now();
			}
		} catch (error) {
			if (run.status === "running") {
				run.status = "error";
				run.error = error instanceof Error ? error.message : String(error);
				run.endedAt = Date.now();
			}
		} finally {
			persistRun(run);
			refreshStatus();
		}
	};

	const resumeRun = (previous: WorkflowRun, ctx: ExtensionContext): void => {
		const run = createRun(previous.name, previous.description, previous.script, previous.args);
		persistRun(run);
		refreshStatus();
		void launchRun(run, ctx, previous.args).then(() => deliverReport(run));
		ctx.ui.notify(`Resumed workflow "${run.name}" (run ${run.id})`, "info");
	};

	const confirmRun = async (name: string, description: string, script: string, ctx: ExtensionContext, plan?: WorkflowPlan): Promise<boolean> => {
		if (!ctx.hasUI) return true;
		const wantsWrites = /"(?:edit|write|bash)"|'(?:edit|write|bash)'|isolated\s*:\s*true/.test(script);
		const accessNote = wantsWrites
			? "⚠ The script requests WRITE/BASH access for some agents."
			: "Agents run with read-only tools.";

		const planNote = plan
			? `Plan: ${plan.stages.map((stage) => `${stage.name} (${stage.mode}, max ${stage.maxAgents})`).join(" → ")}\nExpected agents: ${plan.expectedAgents}\nDecomposition: ${plan.decomposition}`
			: "Saved workflow: no dynamic architecture metadata.";
		return ctx.ui.confirm(
			`Run workflow "${name}"?`,
			`${description}\n\n${planNote}\n\n${accessNote}\nSubagents run as headless pi processes. Caps: ${MAX_CONCURRENT_AGENTS} concurrent, ${MAX_TOTAL_AGENTS} total agents. Watch or stop with /workflows.`,
		);
	};

	const saveRunAsCommand = async (run: WorkflowRun, ctx: ExtensionContext): Promise<void> => {
		const pickedScope = await ctx.ui.select("Save workflow", ["Project", "Personal"]);
		if (!pickedScope) return;
		const scope: WorkflowScope = pickedScope === "Project" ? "project" : "personal";
		if (scope === "project" && !ctx.isProjectTrusted()) {
			ctx.ui.notify("Project workflows require a trusted project", "error");
			return;
		}
		const enteredName = await ctx.ui.input("Command name", run.name);
		if (enteredName === undefined) return;
		const name = (enteredName.trim() || run.name).trim();
		const nameError = validateWorkflowName(name);
		if (nameError) {
			ctx.ui.notify(`Invalid command name: ${nameError}`, "error");
			return;
		}
		const enteredDescription = await ctx.ui.input("Description", run.description);
		if (enteredDescription === undefined) return;
		const description = enteredDescription.trim() || run.description;
		const directory =
			scope === "personal" ? join(getAgentDir(), "workflows") : join(ctx.cwd, CONFIG_DIR_NAME, "workflows");
		const path = join(directory, `${name}.js`);
		try {
			await access(path);
			if (!(await ctx.ui.confirm("Overwrite saved workflow?", path))) return;
		} catch {}
		await saveWorkflowFile(path, serializeSavedWorkflow(name, description, run.script));
		ctx.ui.notify(`Saved /${name} to ${path}. Run /reload to register it.`, "info");
	};

	const launchSavedCommand = async (
		name: string,
		description: string,
		script: string,
		rawArgs: string,
		ctx: ExtensionContext,
	): Promise<void> => {
		uiCtx = ctx;
		if (!(await confirmRun(name, description, script, ctx))) return;
		const args = parseWorkflowArgs(rawArgs);
		const run = createRun(name, description, script, args);
		persistRun(run);
		refreshStatus();
		const completion = launchRun(run, ctx, args);
		if (ctx.mode === "tui" || ctx.mode === "rpc") {
			void completion.then(() => deliverReport(run));
			ctx.ui.notify(`Workflow "${name}" started (run ${run.id})`, "info");
			return;
		}
		await completion;
		deliverReport(run);
	};

	pi.on("session_start", async (_event, ctx) => {
		statusTimer = setInterval(() => {
			if (activeRuns().length) refreshStatus();
		}, 120);
		const snapshots = new Map<number, PersistedWorkflowRun>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === WORKFLOW_STATE_ENTRY && isPersistedWorkflowRun(entry.data)) {
				snapshots.set(entry.data.id, entry.data);
			}
		}
		restoreRuns([...snapshots.values()]);
		for (const snapshot of snapshots.values()) {
			for (const agent of snapshot.agents) {
				const cached = cachedResultFromAgent(agent);
				if (cached) agentCache.set(cached.key, cached);
			}
		}
		persistenceEnabled = true;
		// Action methods are unavailable during extension loading; deactivate once the session runtime exists.
		currentTurnAllowsWorkflow = false;
		hasPendingUserInput = false;
		setWorkflowToolActive(false);
		if (ctx.mode === "tui") {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				workflowEditor = new WorkflowEditor(tui, theme, keybindings);
				return workflowEditor;
			});
		}

		const discovered = await discoverSavedWorkflows(
			join(getAgentDir(), "workflows"),
			join(ctx.cwd, CONFIG_DIR_NAME, "workflows"),
			ctx.isProjectTrusted(),
			BUNDLED_WORKFLOWS_DIRECTORY,
		);
		for (const workflow of discovered.workflows) {
			pi.registerCommand(workflow.name, {
				description: workflow.description,
				handler: (args, commandCtx) =>
					launchSavedCommand(workflow.name, workflow.description, workflow.script, args, commandCtx),
			});
		}
		if (discovered.diagnostics.length && ctx.hasUI) {
			const summary = discovered.diagnostics
				.slice(0, 3)
				.map((item) => `${item.path}: ${item.message}`)
				.join("\n");
			ctx.ui.notify(
				`Skipped ${discovered.diagnostics.length} saved workflow issue(s):\n${summary}${discovered.diagnostics.length > 3 ? "\n…" : ""}`,
				"warning",
			);
		}
	});

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: SCRIPT_API_DOCS,
		parameters: WorkflowParams,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			uiCtx = ctx;

			if (!currentTurnAllowsWorkflow) {
				return {
					content: [
						{
							type: "text",
							text: 'Workflow not started: the current user message must mention "workflows".',
						},
					],
					details: undefined,
				};
			}

			if (!(await confirmRun(params.name, params.description, params.script, ctx, params.plan))) {
				return {
					content: [{ type: "text", text: "The user declined to run this workflow." }],
					details: undefined,
				};
			}

			const run = createRun(params.name, params.description, params.script);
			persistRun(run);
			refreshStatus();

			if (ctx.mode === "tui" || ctx.mode === "rpc") {
				void launchRun(run, ctx).then(() => deliverReport(run));
				return {
					content: [
						{
							type: "text",
							text: `Workflow "${run.name}" started in the background (run ${run.id}). The full report will arrive as a workflow-result message when it completes — do not wait or poll; end your turn after acknowledging the launch. The user can watch or stop it with /workflows.`,
						},
					],
					details: undefined,
				};
			}

			const onAbort = () => stopRun(run);
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await launchRun(run, ctx);
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			return {
				content: [{ type: "text", text: buildReport(run) }],
				details: undefined,
			};
		},
	});

	pi.registerMessageRenderer<{ runId: number; name: string; status: string }>("workflow-result", (message, options, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const allLines = text.split("\n");
		const lines = options.expanded ? allLines : allLines.slice(0, 12);
		const status = message.details?.status;
		const glyph =
			status === "done" ? theme.fg("success", "✔") : status === "aborted" ? theme.fg("warning", "■") : theme.fg("error", "✖");
		const statusWord = status === "done" ? "finished" : status === "aborted" ? "stopped" : "failed";
		const header = `${glyph} ${theme.bold("workflow")} ${theme.fg("accent", message.details?.name ?? "")} ${theme.fg("muted", statusWord)}`;
		const out = [header, ...lines.map((line) => `  ${line}`)];
		if (!options.expanded && allLines.length > 12) {
			out.push(theme.fg("dim", `  … ${allLines.length - 12} more lines (ctrl+o to expand)`));
		}
		return {
			render: (width: number) => out.flatMap((line) => wrapTextWithAnsi(line, width)),
			invalidate: () => {},
		};
	});

	pi.registerCommand("workflows", {
		description: "Manage workflow runs and saved commands",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			const section = await ctx.ui.select("Workflows", ["Workflow runs", "Saved commands"]);
			if (!section) return;

			if (section === "Saved commands") {
				const personalDirectory = join(getAgentDir(), "workflows");
				const projectDirectory = join(ctx.cwd, CONFIG_DIR_NAME, "workflows");
				const discovered = await discoverSavedWorkflows(
					personalDirectory,
					projectDirectory,
					ctx.isProjectTrusted(),
					BUNDLED_WORKFLOWS_DIRECTORY,
				);
				if (!discovered.allWorkflows.length) {
					ctx.ui.notify("No saved workflow commands found", "info");
					return;
				}
				const labels = discovered.allWorkflows.map((workflow) => {
					const status = savedWorkflowStatus(workflow, discovered.workflows);
					const projectRelative = relative(ctx.cwd, workflow.path);
					const displayPath = projectRelative && !projectRelative.startsWith("..") ? projectRelative : workflow.path;
					return `/${workflow.name} · ${workflow.scope} · ${status} · ${displayPath}`;
				});
				const picked = await ctx.ui.select("Saved commands", labels);
				if (!picked) return;
				const workflow = discovered.allWorkflows[labels.indexOf(picked)];
				if (!workflow) return;
				const availableActions = ["Show script", "Show path"];
				if (workflow.scope !== "bundled") availableActions.push("Delete saved command");
				const action = await ctx.ui.select(`/${workflow.name} · ${workflow.scope}`, availableActions);
				if (!action) return;
				if (action === "Show script") {
					try {
						await ctx.ui.editor(`Script — /${workflow.name}`, await readFile(workflow.path, "utf8"));
					} catch (error) {
						ctx.ui.notify(`Unable to read ${workflow.path}: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return;
				}
				if (action === "Show path") {
					ctx.ui.notify(workflow.path, "info");
					return;
				}
				const collidingFallback =
					workflow.scope === "project" &&
					discovered.allWorkflows.some((candidate) => candidate.name === workflow.name && candidate.scope === "personal");
				const warning = `This permanently deletes ${workflow.path}.${collidingFallback ? `\nThe personal /${workflow.name} command will become active after /reload.` : ""}`;
				if (!(await ctx.ui.confirm(`Delete saved command /${workflow.name}?`, warning))) return;
				try {
					await deleteSavedWorkflow(workflow, {
						personalDirectory,
						projectDirectory,
						projectTrusted: ctx.isProjectTrusted(),
					});
					ctx.ui.notify(`Deleted /${workflow.name}. Run /reload to unregister it.`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not delete /${workflow.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			const runs = listRuns();
			if (!runs.length) {
				ctx.ui.notify("No workflow runs in this session", "info");
				return;
			}
			if (ctx.mode === "tui") {
				let unsubscribe = () => {};
				let view: WorkflowProgressView | undefined;
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
					const close = () => done(undefined);
					view = new WorkflowProgressView(theme, {
						close,
						requestRender: () => tui.requestRender(),
						stopRun: (run) => {
							void ctx.ui.confirm(`Stop workflow "${run.name}"?`, "Running and pending agents will be aborted.").then((confirmed) => {
								if (confirmed) stopRun(run);
								tui.requestRender();
							});
						},
						showReport: (run) => {
							void ctx.ui.editor(`Report — ${run.name}`, buildReport(run)).then(() => tui.requestRender());
						},
						saveRun: (run) => {
							void saveRunAsCommand(run, ctx).then(() => tui.requestRender());
						},
						resumeRun: (run) => {
							resumeRun(run, ctx);
							tui.requestRender();
						},
					});
					unsubscribe = subscribeToRuns(() => tui.requestRender());
					return view;
				});
				unsubscribe();
				view?.dispose();
				return;
			}
			const runLabels = runs.map((run) => {
				const totals = runTotals(run);
				const duration = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
				return `[${run.status}] ${run.name} — ${totals.done}/${totals.total} agents · ${formatTokens(totals.tokens)} tok · ${duration}`;
			});
			const pickedRun = await ctx.ui.select("Workflow runs", runLabels);
			if (!pickedRun) return;
			const run = runs[runLabels.indexOf(pickedRun)];
			if (!run) return;

			const actions = ["Show agents", "Show result/report", "Show script", "Show log", "Save as command"];
			if (run.status === "running") actions.unshift("■ Stop run");
			else actions.unshift("Resume run");
			const action = await ctx.ui.select(`${run.name} (run ${run.id})`, actions);
			if (!action) return;

			switch (action) {
				case "Resume run":
					resumeRun(run, ctx);
					break;
				case "■ Stop run":
					stopRun(run);
					refreshStatus();
					ctx.ui.notify(`Stopped workflow "${run.name}"`, "info");
					break;
				case "Show agents": {
					if (!run.agents.length) {
						ctx.ui.notify("No agents spawned yet", "info");
						return;
					}
					const agentLabels = run.agents.map(
						(agent) =>
							`${agentGlyph(agent.status)} #${agent.id} ${agent.label}${agent.cached ? " · cached" : ""} · ${formatTokens(agent.tokens)} tok${agent.activity && agent.status === "running" ? ` · ${agent.activity}` : ""}`,
					);
					const pickedAgent = await ctx.ui.select(`Agents — ${run.name}`, agentLabels);
					if (!pickedAgent) return;
					const agent = run.agents[agentLabels.indexOf(pickedAgent)];
					if (!agent) return;
					const detail = [
						`# Agent ${agent.id}: ${agent.label}`,
						`status: ${agent.status}${agent.model ? ` · model: ${agent.model}` : ""} · ${formatTokens(agent.tokens)} tokens`,
						agent.error ? `error: ${agent.error}` : "",
						"",
						"## Prompt",
						agent.prompt,
						"",
						agent.isolated ? `isolation: temporary Git worktree · ${agent.changedFiles?.length ?? 0} changed files` : "",
						agent.lean ? "mode: lean (extensions, skills, context files, and prompt templates disabled)" : "",
						"## Output",
						agent.output ?? "(none)",
						agent.isolated ? "\n## Changed files" : "",
						agent.isolated ? agent.changedFiles?.join("\n") || "(none)" : "",
						agent.isolated ? "\n## Diff" : "",
						agent.isolated ? agent.diff || "(empty)" : "",
					]
						.filter((line, index) => line !== "" || index > 1)
						.join("\n");
					await ctx.ui.editor(`Agent ${agent.id} — ${agent.label}`, detail);
					break;
				}
				case "Show result/report":
					await ctx.ui.editor(`Report — ${run.name}`, buildReport(run));
					break;
				case "Show script":
					await ctx.ui.editor(`Script — ${run.name}`, run.script);
					break;
				case "Show log":
					await ctx.ui.editor(`Log — ${run.name}`, run.logs.join("\n") || "(empty)");
					break;
				case "Save as command":
					await saveRunAsCommand(run, ctx);
					break;
			}
		},
	});

	pi.on("session_shutdown", () => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		workflowEditor?.dispose();
		workflowEditor = undefined;
		stopAllRuns();
		for (const run of listRuns()) persistRun(run);
		persistenceEnabled = false;
	});
}
