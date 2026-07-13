# pi-workflows

Dynamic workflows for [pi](https://github.com/badlogic/pi-mono), modeled on
[Claude Code workflows](https://code.claude.com/docs/en/workflows): the agent
writes a JavaScript orchestration script that fans out many parallel subagents,
and only the final result lands back in your conversation.

## Usage

Just ask for it in a pi session:

> use a workflow to audit every route handler under src/routes/ for missing auth checks

The agent first designs a structured reasoning plan, then calls the `workflow`
tool with that plan and the JavaScript it compiled from it. The plan must explain
its stage boundaries, bounded parallelism, expected agent count, completion
criteria, and stop conditions. You get a confirmation prompt showing the planned
stages, the run executes in the background (session stays responsive), a status
line shows progress, and the report arrives as a message when it finishes.

Workflows are opt-in per user message: the agent can call the `workflow` tool
only when the current message explicitly contains the standalone word
`workflows` (case-insensitive). A mention in an earlier message
does not authorize a later turn. The tool is dynamically activated only for an
eligible message, so its definition stays out of the model prompt otherwise.
Large tasks that do not mention workflows use the normal tools instead. The bundled
workflow-authoring guidance and worked patterns are also injected only for an eligible
turn, so they consume no prompt space otherwise. Explicit saved commands such as
`/audit-routes` and the `/workflows` management command are unaffected. In TUI mode,
typing the standalone word `workflows` animates it
in the input editor as a visual indication that workflow orchestration can be
activated for the message.

- `/workflows` — open a live **Workflow runs** overlay (progress bars, spinners, and per-agent status update in place; navigate runs and agents, inspect prompt/activity/output/diff, `o` view the report, `s` save the run as a command, `u` resume a prior run, `x` stop, `r` restart a failed agent) or manage **Saved commands**. Non-TUI modes retain the dialog-based run inspector.
- In `pi -p` / `--mode json` (non-interactive), workflows run to completion inside the tool call and the report is the tool result.

## Script API

The script body runs as an async function with these globals:

```js
const architecture = await agent(`Map the objective into at most four coherent
reasoning units grouped by semantics, dependencies, or risks. Do not return one
unit per file. Reply as JSON.`, {
  schema: {
    type: 'object',
    required: ['units'],
    properties: { units: { type: 'array', maxItems: 4, items: { type: 'object' } } },
  },
})
const analyses = await pipeline(architecture.units.slice(0, 4), (unit, index) =>
  agent(`Investigate this coherent unit and return compact evidence: ${JSON.stringify(unit)}`, {
    label: `unit-${index + 1}`,
  }),
)
return await agent(`Integrate these results and check the original completion criteria:
${JSON.stringify(analyses.filter(Boolean))}`, { label: 'integrate' })
```

Agents represent independent reasoning roles or coherent work units—not automatically
files, URLs, claims, tests, or other discovered items. Workflows should use the
smallest useful number of agents and adapt fan-out to evidence discovered by an
initial architecture/scout stage.

- `agent(prompt, opts?)` — spawns one headless `pi -p --mode json --no-session` child.
  Returns the final text, or parsed JSON when `opts.schema` is set.
  Options: `label`, `model` ("provider/model-id"), `thinkingLevel` (`off`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, or `max`; defaults to `high`), `tools` (allowlist —
  **read-only by default**: `read,grep,find,ls`; add `edit`/`write`/`bash` for changes),
  `schema`, `lean`, and `isolated`. Set
  `lean: true` for simple, self-contained fan-out to disable extensions, skills,
  context files (including `AGENTS.md`/`CLAUDE.md`), and prompt templates. Lean agents
  therefore cannot use extension tools or project guidance. Invalid JSON and transient
  provider failures are retried once. With `isolated: true`, the agent runs
  in a temporary detached Git worktree and returns `{ output, diff, changedFiles }`;
  the worktree is deleted after its patch is captured. Isolation cannot be combined
  with `schema`.
- `apply(diff)` — explicitly applies an isolated result's patch to the original
  checkout using `git apply --3way --index`. Until this is called, the original
  checkout is untouched.
- `pipeline(items, fn)` — runs `fn` per item concurrently; a failed item resolves
  to `null` instead of aborting the run.
- `log(msg)` — progress note shown in the status line and run log.
- `args` — input passed to a saved workflow command. JSON arguments are parsed; otherwise the raw string is passed through.
- The script's `return` value becomes the workflow result.

For large read-only audits, lean agents avoid repeatedly loading resources that the
prompt does not need:

```js
const results = await pipeline(files, (file) =>
  agent(`Read ${file} and report deprecated API usage with line numbers.`, {
    label: file,
    lean: true,
  }),
)
return results.filter(Boolean).join("\n\n")
```

Savings depend on the installed resources and workload. Write-capable fan-out can
isolate each agent and selectively apply its result:

```js
const changes = await pipeline(files, (file) =>
  agent(`Migrate ${file} and run its focused tests.`, {
    label: file,
    isolated: true,
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
  }),
)
for (const change of changes.filter(Boolean)) await apply(change.diff)
return changes.filter(Boolean).map((change) => change.output).join("\n\n")
```

## Bundled deep research

`/deep-research` ships with the extension and uses `websearch` and `webfetch` from
the web-tools extension. It fans out bounded research angles, independently verifies
important claims, and returns a sourced synthesis:

```text
/deep-research "What are the practical tradeoffs of SQLite replication options in 2026?"
/deep-research {"question":"Compare current SQLite replication options","breadth":7}
```

The workflow requires web-tools to be installed and enabled. It intentionally does not
use lean agents because lean mode disables extension tools. Personal or project workflows
named `deep-research` can override the bundled command.

## Saved workflows

Place JavaScript workflows in either:

- `~/.pi/agent/workflows/*.js` for personal commands (honors `PI_CODING_AGENT_DIR`).
- `<project>/.pi/workflows/*.js` for trusted-project commands.

Each file contains metadata followed by the normal workflow script body:

```js
export const meta = {
  name: "audit-routes",
  description: "Audit route handlers for missing authentication",
}

const root = args?.root ?? "src/routes"
const found = await agent(`List route files under ${root}`)
return found
```

After `/reload`, this is available as `/audit-routes`. Command precedence is
project > personal > bundled. Arguments are exposed as
`args`: `/audit-routes {"root":"src/api"}` passes an object, while
`/audit-routes src/api` passes the raw string `"src/api"`. A project workflow
wins when its metadata name matches a personal workflow.

Use `/workflows` → **Workflow runs** and press `s` on a run (TUI overlay), or
pick **Save as command** in the dialog flow, to save any run to project or
personal scope. Run `/reload` afterward to register the new command.

Use `/workflows` → **Saved commands** to list every valid personal and trusted
project workflow file. Collisions are shown separately as **active** and
**shadowed**. You can show the script/path or permanently delete the selected
`.js` file. Deletion does not reload the extension or interrupt active runs, so
run `/reload` afterward to unregister the deleted command. If an active project
workflow shadows a personal command with the same name, deleting the project
copy makes the personal copy active after `/reload`; deleting the shadowed
personal copy leaves the project command unchanged.

## Claude Code subagent examples

[`examples/`](examples/) contains installable saved workflows that expose the
`claude` tool from `pi-claude-agent-sdk` to coordinator subagents:

- `claude-review.js` — parallel multi-perspective review followed by synthesis.
- `claude-implement.js` — sequential planning, implementation, and verification.

These examples require the Claude extension and must not use `lean: true`, because
lean workflow agents disable extensions. Claude runs with bypass permissions; the
implementation example directly mutates the current working tree.

## Behavior and limits

- Model-initiated workflows require an explicit `workflows` mention in the
  current user message; the tool is inactive on other turns.
- 8 concurrent subagents, 200 agents per run.
- Subagents inherit your pi config (provider, keys, extensions) and default to
  the session's current model, unless `lean: true` disables nonessential resources.
  `PI_WORKFLOWS_SUBAGENT=1` is set in children so
  they can't recursively launch workflows.
- The script itself has no fs/shell access — only subagents touch the system.
  (Guardrail, not a security boundary.)
- Reports are truncated at 30k chars before entering context.

## Roadmap

- **Implemented:** reliability improvements including schema retry and transient-error retry.
- **Implemented:** temporary Git worktree isolation for parallel write agents, patch capture, and explicit patch application.
- **Implemented:** live `/workflows` progress overlay with run/agent drill-down, individual cancellation, and failed-agent restart.
- **Implemented:** session-backed run history and prompt-keyed agent result caching; resumed or edited workflows run only cache misses.
- **Implemented:** optional lean subagents that skip extensions, skills, context files, and prompt templates.
- **Implemented:** turn-scoped workflow-authoring patterns and a bundled `/deep-research` workflow.
- **Implemented:** plan-first dynamic workflow architecture with explicit decomposition, bounded stages, expected scale, completion criteria, and stop conditions.
- **Future:** deterministic plan linting, approval persistence ("don't ask again"), cost guardrails, and per-stage model routing.

## Development

```sh
bun test/runtime.test.ts                                  # unit tests (mocked subagents)
/Users/…/web-tools/node_modules/.bin/tsc --noEmit         # typecheck (uses homebrew pi types via tsconfig paths)
```
