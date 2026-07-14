# Review extension

Codex-style code reviews for pi.

## Usage

- `/review` opens presets for a base branch, uncommitted changes, a commit, or custom instructions.
- `/review <instructions>` starts a custom review directly.

Reviews run as tracked background Pi subagents using the current model and thinking level. The command returns after spawning the reviewer, and the structured prioritized findings are delivered to the current session when it settles.

Use `/subagents` to inspect the live reviewer transcript or cancel a running review. Reviews share the subagent concurrency limit and use only `read`, `grep`, `find`, `ls`, and `bash` tools.
