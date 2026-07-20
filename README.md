# Pi setup

Personal [Pi](https://pi.dev) configuration packaged as a reproducible collection of extensions, skills, prompt templates, and a theme.

## Included extensions

| Extension              | Purpose                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `answer`               | Extract questions from the latest completed response and answer them in an interactive form (`/answer`, `Ctrl+.`). |
| `background-terminals` | Run, inspect, and stop long-lived shell commands in session-scoped background terminals.                           |
| `clear`                | Start a new session with `/clear`.                                                                                 |
| `git-actions`          | Generate and apply commits, branches, and pull requests (`/commit`, `/new-branch`, `/pr`).                         |
| `git-interceptor`      | Prevent interactive Git editor hangs and block `--no-verify`.                                                      |
| `herdr-agent-state`    | Report Pi's fully settled lifecycle state to Herdr when its integration environment is active.                     |
| `pi-mcp-adapter`       | Discover and invoke MCP tools without loading every tool definition into context.                                  |
| `pi-skill-toggle`      | Manage enabled, hidden, and fully disabled skills with `/skills-toggle`.                                           |
| `review`               | Run structured code reviews through `/review`.                                                                     |
| `save-md`              | Save the latest assistant response with `/save-md`.                                                                |
| `status-bar`           | Show repository, model, usage, cost, and context information.                                                      |
| `subagents`            | Spawn, inspect, await, cancel, and take over Pi, Claude Code, or Codex subagents.                                  |
| `tasks`                | Track branch-aware Claude Code-style tasks, dependencies, owners, progress, and details with `/tasks`.             |
| `web-tools`            | Register `webfetch` and `websearch`.                                                                               |
| `whimsical`            | Rotate the working message shown during turns.                                                                     |
| `workflows`            | Run model-authored multi-agent workflows and inspect them with `/workflows`.                                       |

The package also includes guidance skills for background terminals and subagents, the `deslop` and `restate` prompt templates, and the `github-dark-default` theme.

## UI conventions

Visual consistency is centralized so every extension renders alike:

- **Theme**: `themes/github-dark-default.json` defines the palette; every color routes through `vars`.
- **Shared kit**: `extensions/shared/ui-kit.ts` is the single source for status glyphs (`✓` success, `✗` error, `▲` warning, `●` running, `○` pending), separators (`·` dot, `│` pipe), the `❯` selection prefix, accent divider lines, and the standard `SelectList` theme. New extensions should import it instead of inventing ad-hoc glyphs.
- **Status colors** follow GitHub CI convention: running/pending work is yellow, success green, errors red.
- **Working indicator**: `whimsical` owns the rotating working message. Don't call `setWorkingMessage` from other extensions.

## Install

See [SETUP.md](SETUP.md) for installation, authentication, and validation instructions.

## Development

```sh
npm ci
npm run check
npm test
npm run format:check
```

Extension entry points are listed explicitly in the root `package.json`. Shared implementation modules live in `extensions/shared/` and are not loaded as extensions themselves.
