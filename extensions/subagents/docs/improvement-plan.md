# subagents — Improvement Plan (from an OpenCode comparison)

Date: 2026-08-26. Source of comparison: OpenCode's `task` tool
(`packages/opencode/src/tool/task.ts`, `agent/agent.ts`, `config/agent.ts`,
`agent/subagent-permissions.ts`) versus this extension as audited on the same day.

> **Superseded (2026-08):** `subagent_wait` was removed; `subagent_spawn` blocks by default
> with an optional `background: true`, and the concurrency cap queues instead of failing. See the
> current tool descriptions in `src/prompt.ts`.

> **Status (2026-08-26):** Phase 1 (1a–1d) and Phase 2 are implemented in the working tree
> (uncommitted). Not covered by automated tests: the takeover `queue next turn` hint and chat-row
> retirement (need a TUI double), and live Claude/Codex spawns with a system prompt
> (`npm run test:live`). Phase 3 remains open.

## 1. Where we stand

What we do better than OpenCode:

- Three harnesses (pi in-process, Claude Code SDK, Codex app-server) behind one normalized
  event model; OpenCode only spawns children of itself.
- Background-by-default with a deferred result buffer, explicit `subagent_wait`, and a
  live dashboard/takeover UI with steering. OpenCode's background mode is still behind an
  experimental flag and its only "steer" is a resume prompt.
- A hard concurrency cap with race-safe reservation; OpenCode has none.

What OpenCode does that we lack (ordered by value):

| #   | OpenCode                                                                                                                                                                                       | Us today                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Named agent types** (`general`, `explore`, user-defined `agents/*.md` with frontmatter + prompt body: model, tools/permissions, description, hidden). Roster injected into tool description. | Only `harness` / `model` / `reasoning_effort`. `SpawnTask.tools` exists but is not reachable from the tool. No child preamble. |
| 2   | **Resume by id** (`task_id`): continue a child with its full prior context; sending to a running child queues behind the current run.                                                          | `manager.send` exists, but is only reachable from the takeover UI — the parent model cannot continue a child.                  |
| 3   | Return format keeps the child's **final answer** (last text part, 50 KB cap, spill file).                                                                                                      | `truncateHead` keeps the **first** 24 KB / 600 lines — a long answer loses its conclusion.                                     |
| 4   | Heavy anti-duplication guidance for background tasks ("do not poll, do not duplicate the work, avoid the same files").                                                                         | Spawn result says "runs in the background", nothing about duplication.                                                         |
| 5   | Depth limit config (`subagent_depth`).                                                                                                                                                         | Denylist for pi/claude; Codex is unguarded (full-access shell). Acceptable; no change planned.                                 |
| 6   | Child permission asks bubble to the parent's UI.                                                                                                                                               | N/A — pi has no per-call permission prompts; children run headless by design.                                                  |

Internal debt found in the audit that is worth paying down while in here:

- `BackendCapabilities` is set by every backend and read by nobody; the takeover input steers a
  Codex child as if it supported steering (it silently queues a follow-up turn).
- `subagent_cancel.ids` has no `maxItems` (wait has 64).
- "Cancelled" is inferred by matching `errorText` against two literal strings (`chat-row.ts`).
- `getManager()` can resolve after `session_shutdown` and touch a disposed manager; `chatRows`
  grows for the lifetime of the session.
- `index.ts` (all five tool handlers, budgets, renderers, commands) has no tests.
- `docs/design-plan.md` is stale (paths, file layout, §3.8, open questions).

## 2. Plan

### Phase 1 — adopt OpenCode's best ideas (implement now)

**1a. Named agent definitions.** New `src/agents.ts`.

- `AgentDefinition { name, description, prompt?, harness?, model?, reasoningEffort?, tools?, hidden? }`.
- Built-ins:
  - `general` — no restrictions; the default when `agent` is omitted (identical to today's behavior).
  - `explore` — `tools: ["read", "grep", "find", "ls", "bash"]`, prompt: read-only file-search
    specialist honoring a caller-specified thoroughness (`quick` / `medium` / `very thorough`),
    absolute paths, no file creation or state-changing commands. Mirrors the tool set the
    `review` extension already gives its pi child.
- User-defined: `<agentDir>/agents/*.md` (global, `getAgentDir()`), then `<cwd>/.pi/agents/*.md`
  (project; loaded only when the project is trusted). YAML frontmatter = fields above, markdown
  body = `prompt`. Later sources override earlier ones by name; `disable: true` removes one.
  Parsing must fail soft: a malformed file is skipped with a `ui.notify` warning, never a crash.
- `subagent_spawn` gains `agent?: string` (default `general`). Unknown name → error listing known
  names. The tool description ends with a dynamically built roster: `Available agents:\n- name:
description` (hidden agents omitted), computed at registration time.
- Definition → `SpawnTask`: `harness` defaults from the definition when the caller omits it
  (so `harness` becomes optional in the schema, defaulting to the agent's harness, then `pi`);
  `model` / `reasoningEffort` from the definition unless the caller overrides; `tools` from the
  definition (caller cannot widen); `prompt` → new `SpawnTask.systemPrompt`.
- Backend mapping of `systemPrompt`:
  - pi: `createChildResources({ appendSystemPrompt: [systemPrompt] })` (already supported).
  - claude: `systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt }`.
  - codex: `thread/start` `developerInstructions` if the installed app-server accepts it;
    otherwise prepend `<agent_instructions>…</agent_instructions>` to the first user turn.
- Backend mapping of `tools`: pi → `tools` allowlist (existing); claude → existing
  `claudeToolPolicy` **but** `filesystem.denyWrite` only when the tool set contains no
  `edit`/`write`/`bash`; codex → `SpawnError("codex cannot restrict tools; use pi or claude for
agent X")` — fail closed rather than silently granting full access.
- `skills/subagents/SKILL.md`: add a short "Agents" section (built-ins, how to define one).

**1b. `subagent_send` tool.** `{ id, prompt }`. Running child → steer (or, when
`capabilities.steering` is false, queue as the next turn and say so in the result). Settled child →
restart with the new prompt (existing `manager.send`, cap re-checked). Marks the child unconsumed
again so its next settle is delivered. `btw` ids stay invisible. Description explains that the
child keeps its full prior context — this is the cheap way to "ask a follow-up" instead of
respawning.

**1c. Head+tail truncation.** New shared helper `truncateHeadTail(text, {maxBytes, maxLines,
tailShare})` keeping roughly the last third; marker in the middle: `[… N lines / M bytes omitted;
full transcript in <session file> …]`. Used by `buildSubagentResultMessage`, `subagent_wait`
per-agent sections, and `subagent_check`.

**1d. Prompt guidance.** Spawn result and `SUBAGENT_SPAWN_PROMPT_GUIDELINES` add: don't poll
`subagent_check` in a loop, don't duplicate the child's work or edit the same files, prefer
`subagent_send` over respawning for follow-ups, use `agent: "explore"` for read-only
search/research.

### Phase 2 — hardening (same PR if cheap)

- Takeover input and `subagent_send` consult `backend.capabilities.steering`; Codex shows
  `queued for next turn` instead of pretending to steer.
- `subagent_cancel.ids` → `maxItems: 64`.
- Replace string-matched "Cancelled" with an explicit `SubagentSnapshot.cancelled: boolean` set by
  `settle` when the run was interrupted.
- Guard `getManager()` against resolving after shutdown; remove chat rows from `chatRows` on settle.
- Tests: `agents.test.ts` (parsing, precedence, trust gating, roster text), `index` tool-handler
  tests through the stub backend (spawn with agent, send, wait budgets, unknown ids, truncation).
- Replace `docs/design-plan.md`'s stale sections with a pointer to this file + a current file map.

### Phase 3 — later, needs a product decision

- **Persistence across `/reload`**: reattach pi children by session file, Claude by `resume:
sessionId`, Codex by `thread/resume`. Today everything is killed on shutdown.
- **Per-child wall-clock timeout** (`timeout_minutes` on spawn, default none) so a wedged Claude or
  Codex child cannot sit `running` forever.
- **Token/cost roll-up** of children into the parent's status bar.
- **`@agent` mention** in the parent prompt → synthetic hint to call `subagent_spawn` with that
  agent (OpenCode's `resolvePromptParts` trick). Low value until named agents are in use.

## 3. Non-goals

- Blocking/foreground spawn. Pi runs tool calls sequentially, so a blocking spawn would serialize
  parallel delegation; `subagent_spawn` + `subagent_wait` already covers it.
- Replacing the Effect runtime, the event model, or the UI.
