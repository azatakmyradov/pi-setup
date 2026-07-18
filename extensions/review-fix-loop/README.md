# Review-fix loop extension

Repeatedly reviews, independently verifies, and fixes the current uncommitted changes. The loop starts only from the user-invoked `/review-fix-loop` slash command; it is not exposed as an LLM tool and never starts automatically.

## Pipeline

1. The parent captures Git status and the tracked diff, then `openai-codex/gpt-5.6-sol` reviews staged, unstaged, and untracked changes with read-only Pi tools.
2. Claude Code `fable` independently verifies every finding with a capability-level read-only tool set (`Read`, `Grep`, and `Glob`), isolated settings/MCP configuration, disabled hooks, and a fail-closed sandbox that denies worktree writes.
3. `openai-codex/gpt-5.6-sol` fixes only confirmed findings and runs relevant checks.
4. The loop starts a fresh review and stops when it returns no findings.

The loop stops after five review cycles if it does not converge. The fifth cycle is diagnostic-only, ensuring every automated fix is followed by another review. Rejected findings are included as feedback in the next review so the reviewer does not repeat them without new evidence.

## Commands

- `/review-fix-loop` starts the loop and replaces the TUI editor with a read-only live transcript of the active review, verification, or fix stage. Use the arrow or Page Up/Page Down keys to scroll. Press Escape or Ctrl+C to force-stop the active subagent immediately. Force-stopping a fixer skips the final safety review and may leave partial edits, so inspect the worktree afterward.
- `/review-fix-loop <instructions>` adds review instructions for every iteration.
- `/subagents` can inspect completed stage transcripts after the loop exits.

The extension requires the `subagents` extension, the `openai-codex/gpt-5.6-sol` model, and an authenticated Claude Code installation with the `fable` model alias. RPC mode is intentionally unsupported because Pi cannot guarantee an exclusive worktree lock across concurrent RPC commands.
