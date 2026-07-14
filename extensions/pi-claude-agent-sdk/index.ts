import { query } from "@anthropic-ai/claude-agent-sdk";
import { getMarkdownTheme, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { ClaudeAgentDetails } from "./parser.ts";
import { ClaudeAgentRunner, type QueryFactory } from "./runner.ts";

const Parameters = Type.Object({
	task: Type.String({ description: "Task for a fresh Claude Code agent session", minLength: 1, maxLength: 200_000 }),
	cwd: Type.Optional(Type.String({ description: "Existing working directory, resolved relative to Pi's cwd" })),
	model: Type.Optional(Type.String({ description: "Claude model name; omit to use Claude Code's default" })),
	systemPrompt: Type.Optional(
		Type.String({ description: "Instructions appended to the Claude Code preset system prompt" }),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			description: "Maximum agentic turns (1-100); omit unless a hard cap is required",
			minimum: 1,
			maximum: 100,
		}),
	),
	resumeSessionId: Type.Optional(
		Type.String({ description: "Claude session ID returned by an earlier call; omit to start a new thread", minLength: 1, maxLength: 256 }),
	),
});

function usageLine(details: ClaudeAgentDetails): string {
	const usage = details.usage;
	if (!usage) return "";
	const tokens = usage.inputTokens + usage.outputTokens;
	return `${usage.turns} turn${usage.turns === 1 ? "" : "s"} · ${tokens.toLocaleString()} tokens · $${usage.costUsd.toFixed(4)} · ${(usage.durationMs / 1000).toFixed(1)}s`;
}

function firstText(content: Array<{ type: string; text?: string }>): string {
	return content.find((item) => item.type === "text")?.text ?? "";
}

function compact(value: string, maxLength = 120): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function createClaudeAgentExtension(queryFactory: QueryFactory) {
	return function claudeAgentExtension(pi: ExtensionAPI): void {
		const runner = new ClaudeAgentRunner(queryFactory);
		let claudeArmed = false;

		function setClaudeActive(enabled: boolean): void {
			const activeTools = new Set(pi.getActiveTools());
			if (enabled) activeTools.add("claude");
			else activeTools.delete("claude");
			pi.setActiveTools([...activeTools]);
		}

		pi.on("session_start", () => {
			claudeArmed = false;
			setClaudeActive(false);
		});

		pi.on("input", (event) => {
			if (event.source === "extension") return;
			claudeArmed = /\bclaude\b/i.test(event.text);
			setClaudeActive(claudeArmed);
		});

		pi.on("tool_call", (event) => {
			if (event.toolName !== "claude") return;
			if (!claudeArmed) {
				return {
					block: true,
					reason: "Claude delegation requires 'claude' in the current user message.",
				};
			}
			claudeArmed = false;
		});

		pi.on("tool_result", (event) => {
			if (event.toolName === "claude") setClaudeActive(false);
		});

		pi.on("agent_settled", () => {
			claudeArmed = false;
			setClaudeActive(false);
		});

		pi.on("session_shutdown", () => {
			claudeArmed = false;
			runner.interrupt();
		});

		pi.registerTool({
			name: "claude",
			label: "Claude Agent",
			description: [
				"Delegate one task to Claude Code through @anthropic-ai/claude-agent-sdk.",
				"Omit resumeSessionId to start a new thread, or pass an ID returned by an earlier call to continue it.",
				"The agent runs with bypassPermissions and can directly read, execute commands, and mutate the selected working tree.",
				"Only one invocation may run at a time. Final output is capped at 50 KB.",
			].join(" "),
			promptSnippet: "Run or resume a fully capable Claude Code agent that can directly mutate the working tree",
			promptGuidelines: [
				"Use claude only when direct Claude Code delegation is useful; it bypasses permissions and mutates the same working tree.",
				"Pass claude's returned resumeSessionId when the next delegated task should continue the same Claude thread; omit it for independent tasks.",
				"Omit claude's maxTurns unless a hard cap is required. If claude reports an incomplete turn-limited result, resume the exact returned session ID.",
				"Do not call claude in parallel because its invocations are serialized.",
			],
			renderShell: "self",
			parameters: Parameters,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				return runner.run(params, ctx.cwd, signal, onUpdate);
			},
			renderCall(args, theme) {
				let text = `${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold("Delegate"))}`;
				text += ` ${theme.fg("accent", compact(args.task || "…"))}`;
				if (args.model) text += theme.fg("dim", ` · ${args.model}`);
				if (args.resumeSessionId) text += theme.fg("dim", " · resume");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				const details = result.details as ClaudeAgentDetails | undefined;
				const output = firstText(result.content);
				const fallback = compact(output, 180);
				if (context.isError) {
					return new Text(`  ${theme.fg("error", "✗")} ${theme.fg("error", (expanded ? output : fallback) || "Delegation failed")}`, 0, 0);
				}
				if (!details) {
					const glyph = isPartial ? theme.fg("accent", "⋯") : theme.fg("success", "✓");
					return new Text(`  ${glyph} ${theme.fg("dim", isPartial ? "running" : fallback || "completed")}`, 0, 0);
				}

				const activities = details.activities;
				const running = isPartial || details.status === "running";
				const incomplete = details.status === "incomplete";
				const status = running
					? theme.fg("accent", "⋯")
					: incomplete
						? theme.fg("warning", "⚠")
						: theme.fg("success", "✓");
				const statusWord = running ? "running" : incomplete ? "incomplete" : "completed";

				if (!expanded) {
					let summary = statusWord;
					if (running && activities.length > 0) summary += ` · ${compact(activities.at(-1) || "", 100)}`;
					const usage = usageLine(details);
					if (!running && usage) summary += ` · ${usage}`;
					if (details.truncated) summary += " · truncated";
					if (!running) summary += ` · ${keyHint("app.tools.expand", "details")}`;
					return new Text(`  ${status} ${theme.fg("muted", summary)}`, 0, 0);
				}

				const container = new Container();
				container.addChild(new Text(`  ${status} ${theme.fg("muted", statusWord)}`, 0, 0));
				if (details.sessionId) container.addChild(new Text(theme.fg("dim", `Session: ${details.sessionId}`), 0, 0));
				if (details.stopReason) container.addChild(new Text(theme.fg("warning", details.stopReason), 0, 0));
				if (activities.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", activities.join("\n")), 0, 0));
				}
				if (details.unknownEvents.length > 0) {
					container.addChild(new Text(theme.fg("dim", `Other events: ${details.unknownEvents.join(", ")}`), 0, 0));
				}
				if (details.output) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(details.output, 0, 0, getMarkdownTheme()));
				}
				const usage = usageLine(details);
				if (usage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usage), 0, 0));
				}
				if (details.truncated) container.addChild(new Text(theme.fg("warning", "Output/details were truncated."), 0, 0));
				return container;
			},
		});
	};
}

export default createClaudeAgentExtension(query);
