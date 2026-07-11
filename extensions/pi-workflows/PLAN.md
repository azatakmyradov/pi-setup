# pi-workflows — Improvement Plan

Status: MVP shipped and verified (workflow tool, agent()/pipeline() runtime,
headless pi subagents, background runs, status line, /workflows command,
unit tests + e2e). This plan covers what's next, in priority order.

## 1. Saved workflows (implemented)

Workflows can now be saved and reused as slash commands.

- Scan `~/.pi/agent/workflows/*.js` and `<project>/.pi/workflows/` at startup
  (and on `/reload`); register each file as a `/name` slash command.
- File format: `export const meta = { name, description }` + script body
  (already supported by `transformScript`).
- Pass command arguments to the script as `args` (raw string; attempt JSON
  parse for structured input).
- Add a "Save as command" action in `/workflows` that writes a run's script
  to either location (project vs personal).
- Project workflow wins when names collide with a personal one.

## 2. Reliability pack (implemented)

Cheap fixes that matter at scale — with 50 agents, rare failures are guaranteed.

- **Schema retry**: when an agent returns invalid JSON, re-ask once including
  the parse error, instead of failing the pipeline item.
- **Transient-error retry**: one retry with backoff on rate limits / provider
  errors instead of permanently failing the item.

## 3. Worktree isolation for write agents (implemented)

Parallel agents with edit/write/bash can stomp on each other's files.

- Script option `isolated: true` on `agent()`: create a git worktree per
  agent, run the agent inside it, report the diff; the script (or a final
  merge agent) applies results back.
- This is what makes "migrate 200 components in parallel" safe — without it,
  workflows are only safe for read/analyze tasks.

## 4. Live progress view (implemented)

`/workflows` is a chain of one-shot select dialogs — no live updates.

- Replace with a `ui.custom` overlay that re-renders as agents progress.
- Keys: arrows to select phase/agent, Enter to drill in (prompt, activity,
  output), `x` stop agent/run, `r` restart a failed agent, Esc to back out.
- Keep the one-line task summary in the status line / widget.

## 5. Run persistence + resume (implemented)

Runs vanish when the session ends; a failure at agent 40/50 restarts from zero.

- Persist per-agent results keyed by prompt hash (`appendEntry` or a file
  next to the session).
- On re-run of the same/edited script, cache-hit completed agents and only
  run the rest.
- Let `/workflows` show runs from earlier in the session after reload.

## 6. Cost guardrails

Only protection today is the 200-agent cap — hit after real money is spent.

- Per-run budget option: abort past $X or N tokens.
- Warn when a script schedules more than ~25 agents.
- Show projected scale in the approval prompt.
- Optional size guideline setting injected into the tool docs (small/medium/large).

## 7. Faster/leaner subagents (lean mode implemented)

Each agent boots a full pi with all extensions, skills, and context files.

- `lean: true` option → `--no-extensions --no-skills --no-context-files
  --no-prompt-templates` for simple read-only fan-out agents.
- Estimated 30–50% token saving on large audit runs (every agent currently
  pays for AGENTS.md + extension tool definitions in its system prompt).
- If child startup cost ever dominates: switch hot paths to in-process
  `createAgentSession` from the pi SDK.

## 8. Better script-writing guidance (implemented)

- Inject turn-scoped orchestration guidance only when the current message mentions
  workflows, with worked examples for adversarial verification, a bounded
  fix-until-green loop, and map-reduce with a final synthesizer.
- Ship a bundled, overridable `deep-research.js` workflow using the web-tools extension.
- The model writes noticeably better workflows with full patterns to copy without
  spending prompt context on unrelated turns.

## Recommended order

Do **1 + 2 together** first — saved workflows make it a real feature, the
reliability pack makes 50-agent runs trustworthy. Then **3** to unlock
write-capable workflows (migrations), then 4–8 as polish.
