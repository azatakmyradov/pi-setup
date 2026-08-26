/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. You choose the harness it runs on: pi (in-process pi session, inherits this environment's tools and config), claude (Claude Code), or codex (Codex CLI). Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 4 subagents can be running at once across all harnesses. Pick a named `agent` from the roster below; it decides the child's instructions and tool set, and can default the harness.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Pick the subagent harness deliberately: pi unless you have a reason to prefer Claude Code or Codex (e.g. the user asked for one, or the task suits that harness).",
  'When the user requests a specific subagent model or version, subagent_spawn must pass its exact full identifier in `model`; never substitute a moving alias (for example, use "claude-opus-4-8" for Claude Opus 4.8, not "opus", which means the latest Opus).',
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
  "Never poll subagent_check in a loop to watch a subagent: it burns your context for nothing. Let the result arrive, or block once with subagent_wait.",
  "While a subagent runs, do not redo its task and do not edit the files it is working on. Do unrelated work, or end your turn and wait for its result.",
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
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  agent: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (agent ${options.agent}, ${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.\n` +
    `Do not poll subagent_check in a loop, do not redo its task, and do not edit the files it is working on. ` +
    `Continue with non-overlapping work or end your turn; use subagent_send(id: "${options.id}") for a follow-up instead of spawning again.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes continuing an existing subagent instead of spawning a new one. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a follow-up prompt to an existing subagent, which keeps its full prior context. This is the cheap way to ask a follow-up, correct a misunderstanding, or extend a finished task — always prefer it over spawning a second subagent for the same work. A settled subagent restarts with the new prompt (it counts against the 4 concurrent runs again); a running one is steered mid-run, or queued as its next turn on harnesses that cannot steer. Returns immediately: the result arrives on its own or via subagent_wait.";

/** Model-facing schema descriptions for subagent_send. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: 'Subagent id to send to, e.g. "sa-1"',
  prompt:
    "Follow-up prompt for the subagent. It already remembers its own work but still cannot see this conversation, so include any new context, paths, and what to report back.",
};

/** Builds the subagent_send result, which differs per steering capability. */
export function buildSubagentSendResult(options: {
  id: string;
  title: string;
  running: boolean;
  steering: boolean;
}) {
  const collect = `Its result arrives automatically when the run settles, or collect it with subagent_wait(ids: ["${options.id}"]).`;
  if (!options.running) {
    return `Restarted ${options.id} "${options.title}" with a follow-up; it keeps its full prior context. ${collect}`;
  }
  return options.steering
    ? `Steering ${options.id} "${options.title}" with your follow-up; it keeps its full prior context. ${collect}`
    : `Queued for ${options.id}'s next turn (this harness cannot steer mid-run); it keeps its full prior context. ${collect}`;
}

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/**
 * Builds the child completion/failure wrapper injected into the parent model's
 * context. `output` is already head+tail truncated by the caller (the single
 * truncation point, `truncatedOutput` in index.ts), so the parent always sees
 * the child's conclusion and the marker naming its session file.
 */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
