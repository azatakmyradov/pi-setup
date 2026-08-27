---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Agents

`agent` names a reusable spawn preset: instructions, tool set, and optional default harness/model. Omit it to get `general`. The live roster is printed at the end of the `subagent_spawn` description.

| Agent     | Use it for                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `general` | Default. No extra instructions, no tool restrictions — identical to spawning without an agent.                                         |
| `explore` | Read-only search and research. Tools: read, grep, find, ls, bash. Cannot edit files. Say how thorough: quick / medium / very thorough. |

`agent` supplies the child's system prompt, tool allowlist, and default harness/model; `harness`, `model`, and `reasoning_effort` passed by the caller win over the definition. A tool-restricted agent cannot run on `codex` (the Codex app-server has no tool allowlist, so that spawn fails instead of silently granting full access) — use `pi` or `claude`.

### Defining an agent

Create one markdown file per agent: `~/.pi/agent/agents/<name>.md` for every project, or `<project>/.pi/agents/<name>.md` for one project (loaded only when the project is trusted). The file name is the agent name. Project files override global ones, and both override the built-ins of the same name.

```markdown
---
description: Reviews a diff for correctness bugs and reports findings only
harness: pi
model: openai-codex/gpt-5.6-sol
reasoning_effort: high
tools: [read, grep, find, ls, bash]
hidden: false
---

You review changes for correctness. Report findings with absolute paths and
line numbers, ranked by severity. Never edit files.
```

Only `description` is required; the markdown body becomes the child's appended system prompt. `hidden: true` keeps an agent out of the roster but still spawnable by name, and `disable: true` removes an inherited or built-in agent of that name. A malformed file is skipped with a startup warning, so the other agents keep working.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** Use when the user does not request another harness. It inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted.

Do not use models from the Anthropic provider even if one appears in the model list.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous. Common picks in this environment:

| Model                            | Recommended effort |
| -------------------------------- | ------------------ |
| inherited parent model (default) | inherited          |
| `openai-codex/gpt-5.6-sol`       | `high`             |
| `openai-codex/gpt-5.6-terra`     | `high`             |
| `opencode/claude-fable-5`        | `medium`           |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Claude Code Harness

**Harness:** `claude`
**Prompt nicknames:** “claude”, “Claude Code”, “claude agent”, “claude subagent”, "cc"
**Best default:** use the latest fable model on high reasoning. Do not default to anything else, if the user does not specify, use fable.

| Model hint        | Model               | Recommended effort |
| ----------------- | ------------------- | ------------------ |
| `fable`           | latest Claude Fable | `high`             |
| `claude-opus-4-8` | Claude Opus 4.8     | `high`             |

**Version pinning:** Claude aliases such as `opus`, `sonnet`, and `fable` always select the latest version. When the user requests a specific version, pass its exact full model ID unchanged—for example, use `model: "claude-opus-4-8"` for Claude Opus 4.8, never `model: "opus"`.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The extension maps these to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens respectively.

Requires Claude Code to be installed and authenticated.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Best default:** `gpt-5.6-sol` with `high` effort for coding work. Do not use anything other than sol unless the user specifically asks for it.

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `high`             |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt` and a short `name`, plus optional `agent`, `harness`, `working_dir`, `model`, and `reasoning_effort`. `harness` defaults to the agent definition's harness, then `pi`.

`subagent_spawn` blocks by default: the call waits for the child to finish and returns its output as the tool result — use this whenever the result changes what you do next. Pass `background: true` to return immediately with an id instead; that result is delivered to you as a message after you end your turn. To run several subagents at once, issue multiple `subagent_spawn` calls in a single message — they execute concurrently and their results come back together. At most four subagents run at once; extra spawns are queued and start automatically as slots free. Interrupting a blocking spawn detaches the child instead of killing it: it keeps running and its result arrives as a message.

- `subagent_send({ id, prompt })`: follow up on an existing subagent, which keeps its full prior context. Steering a running child returns immediately (queued as its next turn on `codex`, which cannot steer); a finished child restarts with the new prompt and the call blocks for the restarted run's output, exactly like a foreground spawn — pass `background: true` to return right away instead and get that result as a message. Prefer this over spawning a second subagent for the same task.
- `subagent_check({ id })`: peek at a background subagent without blocking. Never call it in a loop and never call it to wait — a foreground `subagent_spawn` already returns the result.
- `subagent_list()`: list all runs (queued, running, and finished).
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts; cancelling a queued subagent dequeues it.
- `/subagents`: inspect or take over a run interactively.

Foreground is the default — let the tool block instead of managing the wait yourself. Use `background: true` only for independent work you genuinely do not need right now; its result is delivered automatically as a message after you end your turn. Never sleep, never poll `subagent_check` in a loop, and never re-derive a running child's answer yourself. While a subagent runs, do not redo its task and do not edit the files it is working on: do unrelated work, or end your turn.
