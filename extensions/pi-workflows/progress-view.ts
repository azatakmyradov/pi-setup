import type { WorkflowRun, AgentRecord } from "./runs.ts";
import { formatDuration, formatTokens, listRuns, restartAgent, runTotals, stopAgent } from "./runs.ts";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface ProgressTheme {
	fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text", text: string): string;
	bold(text: string): string;
}

export interface ProgressViewActions {
	close(): void;
	stopRun(run: WorkflowRun): void;
	showReport(run: WorkflowRun): void;
	saveRun(run: WorkflowRun): void;
	resumeRun(run: WorkflowRun): void;
	requestRender(): void;
}

type Level = "runs" | "agents" | "detail";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUN_ROWS = 12;
const AGENT_ROWS = 14;
const DETAIL_ROWS = 24;

export function spinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length]!;
}

export function progressBar(done: number, total: number, width: number): string {
	const filled = total > 0 ? Math.min(width, Math.round((done / total) * width)) : 0;
	return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export function formatCost(cost: number): string {
	return cost >= 0.095 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

type StatusColor = "accent" | "success" | "error" | "warning" | "dim";

function statusColor(status: string): StatusColor {
	switch (status) {
		case "done":
			return "success";
		case "error":
			return "error";
		case "aborted":
			return "warning";
		case "running":
			return "accent";
		default:
			return "dim";
	}
}

function statusGlyph(status: string): string {
	switch (status) {
		case "done":
			return "✔";
		case "error":
			return "✖";
		case "aborted":
			return "■";
		case "running":
			return spinnerFrame();
		default:
			return "·";
	}
}

function windowStart(length: number, selected: number, rows: number): number {
	if (length <= rows) return 0;
	return Math.max(0, Math.min(selected - Math.floor(rows / 2), length - rows));
}

export class WorkflowProgressView {
	private level: Level = "runs";
	private runIndex = 0;
	private agentIndex = 0;
	private scroll = 0;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(private readonly theme: ProgressTheme, private readonly actions: ProgressViewActions) {
		// Run updates are event-driven, but elapsed time and spinner frames are not.
		// A modest interval keeps the view live without overwhelming terminal redraws.
		this.timer = setInterval(() => {
			if (listRuns().some((run) => run.status === "running")) this.actions.requestRender();
		}, 120);
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	private runs(): WorkflowRun[] {
		return listRuns();
	}

	private run(): WorkflowRun | undefined {
		const runs = this.runs();
		this.runIndex = Math.min(this.runIndex, Math.max(0, runs.length - 1));
		return runs[this.runIndex];
	}

	private agent(): AgentRecord | undefined {
		const run = this.run();
		if (!run) return;
		this.agentIndex = Math.min(this.agentIndex, Math.max(0, run.agents.length - 1));
		return run.agents[this.agentIndex];
	}

	private moveSelection(delta: number): void {
		if (this.level === "runs") {
			this.runIndex = Math.max(0, Math.min(this.runs().length - 1, this.runIndex + delta));
		} else if (this.level === "agents") {
			const count = this.run()?.agents.length ?? 0;
			this.agentIndex = Math.max(0, Math.min(count - 1, this.agentIndex + delta));
		}
	}

	handleInput(data: string): void {
		const run = this.run();
		const agent = this.agent();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			if (this.level === "detail") this.level = "agents";
			else if (this.level === "agents") this.level = "runs";
			else this.actions.close();
			this.scroll = 0;
		} else if (matchesKey(data, Key.up)) {
			if (this.level === "detail") this.scroll = Math.max(0, this.scroll - 1);
			else this.moveSelection(-1);
		} else if (matchesKey(data, Key.down)) {
			if (this.level === "detail") this.scroll++;
			else this.moveSelection(1);
		} else if (matchesKey(data, Key.pageUp)) {
			if (this.level === "detail") this.scroll = Math.max(0, this.scroll - (DETAIL_ROWS - 2));
			else this.moveSelection(-(this.level === "runs" ? RUN_ROWS : AGENT_ROWS));
		} else if (matchesKey(data, Key.pageDown)) {
			if (this.level === "detail") this.scroll += DETAIL_ROWS - 2;
			else this.moveSelection(this.level === "runs" ? RUN_ROWS : AGENT_ROWS);
		} else if (matchesKey(data, Key.home)) {
			if (this.level === "detail") this.scroll = 0;
			else this.moveSelection(-Number.MAX_SAFE_INTEGER);
		} else if (matchesKey(data, Key.end)) {
			if (this.level === "detail") this.scroll = Number.MAX_SAFE_INTEGER;
			else this.moveSelection(Number.MAX_SAFE_INTEGER);
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (this.level === "runs" && run) this.level = "agents";
			else if (this.level === "agents" && agent) this.level = "detail";
			this.scroll = 0;
		} else if (data === "x" && run) {
			if (this.level === "runs") {
				if (run.status === "running") this.actions.stopRun(run);
			} else if (agent) {
				stopAgent(run, agent);
			}
		} else if (data === "r" && this.level !== "runs" && agent) {
			void restartAgent(agent)?.catch(() => {});
		} else if (data === "o" && this.level === "runs" && run) {
			this.actions.showReport(run);
		} else if (data === "s" && this.level === "runs" && run) {
			this.actions.saveRun(run);
		} else if (data === "u" && this.level === "runs" && run && run.status !== "running") {
			this.actions.resumeRun(run);
		}
		this.actions.requestRender();
	}

	private spread(left: string, right: string, width: number): string {
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (gap < 1) return truncateToWidth(left, width);
		return `${left}${" ".repeat(gap)}${right}`;
	}

	private dot(): string {
		return this.theme.fg("dim", " · ");
	}

	private breadcrumb(): string {
		const t = this.theme;
		const parts = [t.bold(t.fg("accent", "Workflows"))];
		if (this.level !== "runs") {
			const run = this.run();
			if (run) parts.push(t.bold(run.name));
		}
		if (this.level === "detail") {
			const agent = this.agent();
			if (agent) parts.push(t.bold(`#${agent.id} ${agent.label}`));
		}
		return ` ${parts.join(t.fg("dim", " › "))}`;
	}

	private headerSummary(): string {
		const t = this.theme;
		const runs = this.runs();
		const count = (status: string) => runs.filter((run) => run.status === status).length;
		const parts: string[] = [];
		if (count("running")) parts.push(t.fg("accent", `${count("running")} running`));
		if (count("error")) parts.push(t.fg("error", `${count("error")} failed`));
		if (count("aborted")) parts.push(t.fg("warning", `${count("aborted")} stopped`));
		if (count("done")) parts.push(t.fg("success", `${count("done")} done`));
		return parts.join(this.dot());
	}

	private renderRuns(inner: number): string[] {
		const t = this.theme;
		const runs = this.runs();
		const lines: string[] = [];
		if (!runs.length) {
			lines.push(t.fg("muted", "  No workflow runs in this session"));
			return lines;
		}
		const start = windowStart(runs.length, this.runIndex, RUN_ROWS);
		if (start > 0) lines.push(t.fg("dim", `   … ${start} earlier`));
		for (const [index, run] of runs.slice(start, start + RUN_ROWS).entries()) {
			const absolute = start + index;
			const selected = absolute === this.runIndex;
			const totals = runTotals(run);
			const pointer = selected ? t.fg("accent", "❯") : " ";
			const glyph = t.fg(statusColor(run.status), statusGlyph(run.status));
			const name = selected ? t.bold(run.name) : run.name;
			const bar = t.fg(run.status === "error" ? "error" : "accent", progressBar(totals.done, totals.total, 10));
			const bits = [`${totals.done}/${totals.total}`];
			if (totals.failed) bits.push(t.fg("error", `${totals.failed} failed`));
			bits.push(`${formatTokens(totals.tokens)} tok`);
			if (totals.cost) bits.push(formatCost(totals.cost));
			bits.push(formatDuration((run.endedAt ?? Date.now()) - run.startedAt));
			lines.push(` ${pointer} ${glyph} ${name}  ${bar} ${bits.join(this.dot())}`);
			if (selected && run.description) {
				lines.push(t.fg("muted", `     ${run.description}`));
			}
		}
		const below = runs.length - start - RUN_ROWS;
		if (below > 0) lines.push(t.fg("dim", `   … ${below} more`));
		return lines;
	}

	private renderAgents(inner: number): string[] {
		const t = this.theme;
		const run = this.run();
		const lines: string[] = [];
		if (!run) return [t.fg("muted", "  Run unavailable")];
		const totals = runTotals(run);
		const pending = totals.total - totals.done - totals.running - totals.failed;
		const summaryBits = [`${totals.done}/${totals.total} agents`];
		if (totals.running) summaryBits.push(t.fg("accent", `${totals.running} running`));
		if (pending > 0) summaryBits.push(t.fg("dim", `${pending} pending`));
		if (totals.failed) summaryBits.push(t.fg("error", `${totals.failed} failed`));
		summaryBits.push(`${formatTokens(totals.tokens)} tok`);
		if (totals.cost) summaryBits.push(formatCost(totals.cost));
		summaryBits.push(formatDuration((run.endedAt ?? Date.now()) - run.startedAt));
		lines.push(` ${t.fg(run.status === "error" ? "error" : "accent", progressBar(totals.done, totals.total, 14))} ${summaryBits.join(this.dot())}`);
		const lastLog = run.logs[run.logs.length - 1];
		if (lastLog) lines.push(t.fg("muted", truncateToWidth(` ${lastLog}`, inner)));
		lines.push("");
		if (!run.agents.length) {
			lines.push(t.fg("muted", "  No agents spawned yet"));
			return lines;
		}
		const start = windowStart(run.agents.length, this.agentIndex, AGENT_ROWS);
		if (start > 0) lines.push(t.fg("dim", `   … ${start} above`));
		for (const [index, agent] of run.agents.slice(start, start + AGENT_ROWS).entries()) {
			const absolute = start + index;
			const selected = absolute === this.agentIndex;
			const pointer = selected ? t.fg("accent", "❯") : " ";
			const glyph = t.fg(statusColor(agent.status), statusGlyph(agent.status));
			const label = selected ? t.bold(agent.label) : agent.label;
			const bits: string[] = [];
			if (agent.status === "pending") {
				bits.push(t.fg("dim", "queued"));
			} else {
				if (agent.cached) bits.push(t.fg("success", "cached"));
				bits.push(`${formatTokens(agent.tokens)} tok`);
				if (agent.startedAt) bits.push(formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt));
				if (agent.status === "running" && agent.activity) bits.push(t.fg("muted", agent.activity));
				if (agent.status === "error" && agent.error) bits.push(t.fg("error", agent.error));
			}
			lines.push(truncateToWidth(` ${pointer} ${glyph} ${t.fg("dim", `#${String(agent.id).padStart(2)}`)} ${label}${this.dot()}${bits.join(this.dot())}`, inner));
		}
		const below = run.agents.length - start - AGENT_ROWS;
		if (below > 0) lines.push(t.fg("dim", `   … ${below} more`));
		return lines;
	}

	private colorDiffLine(line: string): string {
		const t = this.theme;
		if (line.startsWith("+++") || line.startsWith("---")) return t.fg("muted", line);
		if (line.startsWith("@@")) return t.fg("accent", line);
		if (line.startsWith("+")) return t.fg("success", line);
		if (line.startsWith("-")) return t.fg("error", line);
		return line;
	}

	private renderDetail(inner: number): string[] {
		const t = this.theme;
		const agent = this.agent();
		if (!agent) return [t.fg("muted", "  Agent unavailable")];
		const section = (title: string) => t.bold(t.fg("accent", title));
		const meta: string[] = [t.fg(statusColor(agent.status), agent.status)];
		if (agent.model) meta.push(agent.model);
		meta.push(`${formatTokens(agent.tokens)} tok`);
		if (agent.cost) meta.push(formatCost(agent.cost));
		if (agent.startedAt) meta.push(formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt));
		if ((agent.attempts ?? 1) > 1) meta.push(`attempt ${agent.attempts}`);
		const detail: string[] = [meta.join(this.dot())];
		if (agent.status === "running" && agent.activity) detail.push(t.fg("muted", agent.activity));
		if (agent.error) detail.push(t.fg("error", `Error: ${agent.error}`));
		detail.push("", section("Prompt"), ...agent.prompt.split("\n"));
		detail.push("", section("Output"), ...(agent.output ?? t.fg("dim", "(none)")).split("\n"));
		if (agent.isolated) {
			const changed = agent.changedFiles ?? [];
			detail.push("", section(`Changed files (${changed.length})`), ...(changed.length ? changed : [t.fg("dim", "(none)")]));
			const diffLines = agent.diff ? agent.diff.split("\n").map((line) => this.colorDiffLine(line)) : [t.fg("dim", "(empty)")];
			detail.push("", section("Diff"), ...diffLines);
		}
		const wrapped = detail.flatMap((line) => wrapTextWithAnsi(line, inner - 1));
		const maxScroll = Math.max(0, wrapped.length - DETAIL_ROWS);
		this.scroll = Math.min(this.scroll, maxScroll);
		const lines = wrapped.slice(this.scroll, this.scroll + DETAIL_ROWS).map((line) => ` ${line}`);
		if (wrapped.length > DETAIL_ROWS) {
			lines.push(t.fg("dim", ` lines ${this.scroll + 1}–${Math.min(this.scroll + DETAIL_ROWS, wrapped.length)} of ${wrapped.length}`));
		}
		return lines;
	}

	private footer(): string {
		const t = this.theme;
		const hint = (keys: string, label: string) => `${t.fg("text", keys)} ${t.fg("dim", label)}`;
		const run = this.run();
		const agent = this.agent();
		const parts: string[] = [];
		if (this.level === "detail") {
			parts.push(hint("↑↓", "scroll"), hint("pgup/pgdn", "page"));
			if (agent && (agent.status === "running" || agent.status === "pending")) parts.push(hint("x", "stop agent"));
			if (agent && (agent.status === "error" || agent.status === "aborted")) parts.push(hint("r", "re-run"));
			parts.push(hint("esc", "back"));
		} else if (this.level === "agents") {
			parts.push(hint("↑↓", "select"), hint("enter", "details"));
			if (agent && (agent.status === "running" || agent.status === "pending")) parts.push(hint("x", "stop agent"));
			if (agent && (agent.status === "error" || agent.status === "aborted")) parts.push(hint("r", "re-run"));
			parts.push(hint("esc", "back"));
		} else {
			parts.push(hint("↑↓", "select"), hint("enter", "agents"), hint("o", "report"), hint("s", "save"));
			if (run && run.status !== "running") parts.push(hint("u", "resume"));
			if (run?.status === "running") parts.push(hint("x", "stop"));
			parts.push(hint("esc", "close"));
		}
		return ` ${parts.join(t.fg("dim", "  "))}`;
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const lines = [this.spread(this.breadcrumb(), `${this.headerSummary()} `, width - 1)];
		lines.push(this.theme.fg("dim", ` ${"─".repeat(Math.max(10, Math.min(inner, 72)))}`));
		if (this.level === "runs") lines.push(...this.renderRuns(inner));
		else if (this.level === "agents") lines.push(...this.renderAgents(inner));
		else lines.push(...this.renderDetail(inner));
		lines.push("", this.footer());
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}
