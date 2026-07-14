# Review extension

Codex-style code reviews for pi.

## Usage

- `/review` opens presets for a base branch, uncommitted changes, a commit, or custom instructions.
- `/review <instructions>` starts a custom review directly.

The extension runs a dedicated review subagent with the current model, applies the Codex review rubric, and returns structured prioritized findings to the current session. While it runs, the review panel shows a rolling log of tool activity, inspected files and Git commands. Branch and commit pickers are searchable; Escape returns to the preset menu.
