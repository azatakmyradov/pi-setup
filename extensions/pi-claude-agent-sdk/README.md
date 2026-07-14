# pi-claude-agent-sdk

An installable [Pi](https://github.com/badlogic/pi-mono) package that exposes one `claude` tool backed by `@anthropic-ai/claude-agent-sdk`. Calls can start a new Claude Code thread or resume a session returned by an earlier call.

## Installation

Install dependencies when developing this working copy:

```sh
cd /Users/azatakmyradov/personal/pi-setup/extensions/pi-claude-agent-sdk
npm install
```

Install the local package in Pi (this updates Pi's package settings):

```sh
pi install /Users/azatakmyradov/personal/pi-setup/extensions/pi-claude-agent-sdk
```

For a one-off trial without changing package settings:

```sh
pi -e /Users/azatakmyradov/personal/pi-setup/extensions/pi-claude-agent-sdk
```

## Authentication

The extension does not store, forward, or configure credentials. The Agent SDK/Claude Code process uses its normal supported authentication, such as an existing Claude Code login or `ANTHROPIC_API_KEY`. Authenticate with the installed Claude Code tooling or set the environment before starting Pi. Authentication failures are thrown as tool failures.

No live request is made during installation or tests.

## Critical security warning

**Every invocation hard-codes `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true`.** There is no approval step. Claude Code can run commands and read, create, edit, or delete files with the permissions of the Pi process.

The delegated agent uses the selected working directory directly. It does **not** use a sandbox or temporary worktree, so changes immediately mutate the same working tree that Pi and the user are using. Review tasks and repository trust before calling the tool. Use source control and backups.

## Usage

The `claude` tool is disabled by default. It is enabled for one agent run only when the current user message contains the standalone word `claude` (case-insensitive), then disabled again. Messages that do not mention Claude cannot invoke it.

Ask Pi to delegate a task with a prompt such as `Use Claude to review this change`, or call the tool with:

```json
{
  "task": "Implement the parser and run its focused tests",
  "cwd": "./packages/parser",
  "model": "claude-sonnet-4-6",
  "systemPrompt": "Keep public APIs backward compatible.",
  "maxTurns": 12,
  "resumeSessionId": "optional-session-id-from-an-earlier-call"
}
```

- `task` is required.
- `cwd` is optional, resolved against Pi's current directory, and must be an accessible directory.
- `model` is optional; omission keeps Claude Code's default model selection.
- `systemPrompt` is optional. It is appended to the SDK's typed `claude_code` system-prompt preset rather than replacing that preset.
- `maxTurns` is optional and constrained to 1–100. Omit it unless a hard cap is needed; a low cap can stop an agent before it produces its final answer.
- `resumeSessionId` is optional. Omit it to start a new thread; pass the ID shown in an earlier result to continue that Claude thread.

The extension assigns every fresh invocation an explicit UUID before starting Claude Code. This keeps streamed SDK metadata, the model-visible continuation ID, and the persisted transcript filename aligned. Successful and turn-limited results include this authoritative Claude session ID in both the tool details and a model-visible footer. Claude Code persists these sessions in its normal project-session storage (typically under `~/.claude/projects/`), so they can be resumed across Pi restarts while that storage remains available. Use an ID with the same project context it was created for; omit it when a task should be independent.

Partial assistant text, tool use, final result, usage, and unfamiliar SDK event kinds are summarized in progress/details. Updates are throttled and capped. The model-visible final text, including its continuation footer, is capped at 50 KB; each complete JSON-serialized render-details object is capped at 16 KB, including session ID, output, activity, unknown-event, and usage fields. Event strings and list counts are bounded too. Expand the tool row in Pi to see the bounded transcript details and usage.

## Serialization and interruption

Only one `claude` call can run at a time in an extension instance. Concurrent calls fail immediately instead of racing over the same working tree. A new SDK query object is created for each invocation. Calls without `resumeSessionId` start a new persisted Claude session; calls with it set the SDK's `resume` option and continue that stored session.

Pi's tool `AbortSignal` aborts the SDK controller and closes the query. `session_shutdown` (quit, reload, new/resume/fork) interrupts an active query through the same cleanup path. A maximum-turns stop is returned as a warning-colored, resumable `incomplete` result rather than a failed tool call; it includes partial text when available and the exact session ID to resume. Other SDK failures, missing results, invalid directories, aborts, and concurrency violations are thrown so Pi records a failed tool call.

## Testing

The test suite injects async mock queries and needs no Claude credentials or network access:

```sh
npm test
npm run typecheck
# or both
npm run check
```

Tests cover opt-in tool activation, event parsing, authoritative fresh/resumed session IDs, resumable maximum-turn handling (including SDK-thrown errors), other SDK failure propagation, abort wiring, concurrency rejection, and all output/list bounds. There are intentionally no live tests.

## Limitations

- Bypass mode is unconditional and intentionally unsafe for untrusted tasks or repositories.
- Output and rendering details are truncated. Full Claude session transcripts are managed by Claude Code's local session storage, not embedded in Pi's session file.
- Removing or making Claude's project-session storage unavailable prevents old IDs from being resumed.
- Claude Code's own local settings, tools, hooks, and authentication behavior may affect new and resumed queries.
- The package serializes calls only within its loaded extension instance; another Pi process can still mutate the same tree concurrently.
- Shutdown and abort are cooperative with the SDK/process cleanup implementation.

## Non-goals

This package is not a Pi model provider. It does not implement automatic last-thread selection, Pi-managed transcript persistence, approvals, permission prompts, a sandbox, worktree isolation, or live/credentialed tests.
