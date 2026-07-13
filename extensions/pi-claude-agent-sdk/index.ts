import { query } from "@anthropic-ai/claude-agent-sdk";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
		Type.Integer({ description: "Maximum agentic turns (1-100)", minimum: 1, maximum: 100 }),
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

export function createClaudeAgentExtension(queryFactory: QueryFactory) {
	return function claudeAgentExtension(pi: ExtensionAPI): void {
		const runner = new ClaudeAgentRunner(queryFactory);

		pi.on("session_shutdown", () => {
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
				"Do not call claude in parallel because its invocations are serialized.",
			],
			parameters: Parameters,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				return runner.run(params, ctx.cwd, signal, onUpdate);
			},
			renderCall(args, theme) {
				const task = args.task?.replace(/\s+/g, " ") || "…";
				const preview = task.length > 90 ? `${task.slice(0, 90)}…` : task;
				let text = theme.fg("toolTitle", theme.bold("claude"));
				if (args.model) text += theme.fg("muted", ` ${args.model}`);
				if (args.resumeSessionId) text += theme.fg("muted", ` resume ${args.resumeSessionId}`);
				text += `\n${theme.fg("dim", preview)}`;
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				const details = result.details as ClaudeAgentDetails | undefined;
				if (!details) return new Text(firstText(result.content), 0, 0);
				const activities = details.activities;
				const status = isPartial || details.status === "running" ? theme.fg("warning", "● running") : theme.fg("success", "✓ completed");

				if (!expanded) {
					const recent = activities.slice(-4).map((item) => theme.fg("muted", item));
					const output = details.output.split("\n").slice(0, 4).join("\n");
					const lines = [status, ...recent];
					if (output) lines.push(theme.fg("toolOutput", output));
					const usage = usageLine(details);
					if (usage) lines.push(theme.fg("dim", usage));
					if (activities.length > 4 || details.output.split("\n").length > 4) lines.push(theme.fg("dim", "(expand for details)"));
					return new Text(lines.join("\n"), 0, 0);
				}

				const container = new Container();
				container.addChild(new Text(status, 0, 0));
				if (details.sessionId) container.addChild(new Text(theme.fg("dim", `Session: ${details.sessionId}`), 0, 0));
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
