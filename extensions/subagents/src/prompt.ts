/** All model-facing strings for the subagents tools. */

import type { SubagentStatus } from "./domain.ts";

/** Describes subagent_spawn, including harnesses, blocking, and the concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. You choose the harness: pi (in-process pi session, inherits this environment's tools and config), claude (Claude Code), or codex (Codex CLI). By default this blocks until the subagent finishes and returns its output — that is the mode to use when you need the result. Pass `background: true` to return immediately with an id instead; a background result is delivered to you as a message after you end your turn. To run several subagents at once, issue multiple subagent_spawn calls in a single message — they execute concurrently. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. At most 4 subagents run at once across all harnesses; extra spawns are queued and start automatically as slots free. Pick a named `agent` from the roster below; it decides the child's instructions and tool set, and can default the harness.";

/** Adds subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task; blocks for its output by default, or runs in the background";

/** Guides the parent model to fan out in the foreground and never poll a running child. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks; give every child a complete, standalone prompt with paths, constraints, and the report you expect.",
  "To run work in parallel, put several subagent_spawn calls in a single message: they all start at once and you get every result together. This is the preferred shape for fan-out.",
  "Foreground is the default and is what you want whenever the result changes what you do next: the call blocks and returns the child's output directly.",
  "Use background: true only for work you genuinely do not need right now — its result arrives as a message after you end your turn.",
  "Never sleep, never poll subagent_check in a loop, and never re-derive a running child's answer yourself: let the tool block, or end your turn and let the background result arrive.",
  "While a subagent runs, do not redo its task and do not edit the files it is working on. Do unrelated work, or end your turn.",
  "Pick the subagent harness deliberately: pi unless you have a reason to prefer Claude Code or Codex (e.g. the user asked for one, or the task suits that harness).",
  'When the user requests a specific subagent model or version, subagent_spawn must pass its exact full identifier in `model`; never substitute a moving alias (for example, use "claude-opus-4-8" for Claude Opus 4.8, not "opus", which means the latest Opus).',
  "To follow up on an existing subagent (a question, a correction, or more work on the same task), use subagent_send instead of spawning a new one: the child keeps its full prior context.",
  'Pick the subagent `agent` from the roster in the subagent_spawn description: use `agent: "explore"` for read-only search and research (it cannot edit files), and the default `general` for work that changes the workspace. An agent definition already carries its harness, model, and tool set, so only pass `harness`/`model`/`reasoning_effort` when you need to override it.',
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  agent:
    'Named agent definition to spawn, from the roster at the end of this tool description (default: "general", unrestricted). The definition supplies the child\'s instructions and tool set, plus a default harness/model when it has one.',
  harness:
    'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment), "claude" (Claude Code), or "codex" (Codex CLI). Choose deliberately per task. Omit to use the agent definition\'s harness (default: "pi").',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: exact full ID such as "claude-opus-4-8", or a moving alias such as "opus" only when the latest version is intended; codex: model slug). Preserve any model/version the user specifies exactly. Omit for the harness default (pi inherits the current model).',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Omit for the harness default (pi inherits the current level).",
  background:
    "Set true to run this subagent in the background: the call returns immediately with its id and the result is delivered to you as a message after you end your turn. Default false — the call blocks until the subagent finishes and returns its output directly.",
};

/**
 * Builds the subagent_spawn result for a spawn that is not returning the
 * child's output itself: a background spawn, or the same spawn queued behind
 * the running subagents. A blocking spawn returns the child's sections
 * instead, so it never uses this.
 */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  agent: string;
  harness: string;
  modelLabel: string;
  cwd: string;
  background?: boolean;
  queued?: boolean;
}) {
  const header = `Spawned subagent ${options.id} "${options.title}" (agent ${options.agent}, ${options.harness}: ${options.modelLabel}, ${options.cwd}).`;
  const start = options.queued
    ? "It is queued behind the running subagents and starts automatically when a slot frees."
    : "It is running now.";
  const tools = `Use subagent_check to peek, subagent_cancel to stop it, subagent_list to see all, and subagent_send(id: "${options.id}") for a follow-up instead of spawning again.`;
  if (options.background !== true) {
    return `${header}\n${start} This call is waiting for it and will return its output.\n${tools}`;
  }
  return (
    `${header}\n${start} ` +
    `Its result will be delivered to you as a message after you end your turn. ` +
    `Keep working on non-overlapping tasks meanwhile. ` +
    `Do not sleep, do not poll subagent_check in a loop, do not redo its task, and do not edit the files it is working on.\n` +
    tools
  );
}

/** Builds the result for a blocking spawn whose wait was interrupted. */
export function buildSubagentDetachedResult(options: { id: string; title: string }) {
  return (
    `Subagent ${options.id} "${options.title}" was detached to the background; ` +
    `it is still running and its result will arrive as a message. ` +
    `Do not respawn it and do not redo its work.`
  );
}

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes continuing an existing subagent instead of spawning a new one. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a follow-up prompt to an existing subagent, which keeps its full prior context. This is the cheap way to ask a follow-up, correct a misunderstanding, or extend a finished task — always prefer it over spawning a second subagent for the same work. A running subagent is steered mid-run (or queued as its next turn on harnesses that cannot steer) and the call returns immediately, because that run's result already goes wherever its spawn call directed it. A settled subagent restarts with the new prompt (it counts against the 4 concurrent runs again), and the call then blocks until the restarted run finishes and returns its output — pass `background: true` to return immediately instead and receive that result as a message after you end your turn.";

/** Model-facing schema descriptions for subagent_send. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: 'Subagent id to send to, e.g. "sa-1"',
  prompt:
    "Follow-up prompt for the subagent. It already remembers its own work but still cannot see this conversation, so include any new context, paths, and what to report back.",
  background:
    "Only applies when the subagent has already finished and this restarts it. Default false — block for the restarted run's output.",
};

/**
 * Builds the subagent_send result, which differs per steering capability. A
 * blocking restart returns the restarted run's sections instead, so the
 * restart wording here is only for `background: true`.
 */
export function buildSubagentSendResult(options: {
  id: string;
  title: string;
  running: boolean;
  steering: boolean;
}) {
  const collect = "Its result arrives as a message when the run settles.";
  if (!options.running) {
    return (
      `Restarted ${options.id} "${options.title}" with a follow-up; it keeps its full prior context. ` +
      `It runs in the background: its result will be delivered to you as a message after you end your turn. ` +
      `Do not sleep, do not poll subagent_check in a loop, and do not redo its work.`
    );
  }
  return options.steering
    ? `Steering ${options.id} "${options.title}" with your follow-up; it keeps its full prior context. ${collect}`
    : `Queued for ${options.id}'s next turn (this harness cannot steer mid-run); it keeps its full prior context. ${collect}`;
}

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result. For a background subagent only — never call this in a loop, and never call it to wait: a foreground subagent_spawn already returns the result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked queued, running, and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (queued, running, and finished) with their harness and status.";

/**
 * Builds the child completion/failure wrapper injected into the parent model's
 * context. `output` is already head+tail truncated by the caller (the single
 * truncation point, `truncatedOutput` in index.ts), so the parent always sees
 * the child's conclusion and the marker naming its session file.
 */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: SubagentStatus;
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
