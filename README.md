# Pi setup

Personal [Pi](https://pi.dev) configuration packaged as a reproducible collection of extensions, prompt templates, and a theme.

## Included extensions

| Extension             | Purpose                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `answer`              | Extract questions from the latest completed response and answer them in an interactive form (`/answer`, `Ctrl+.`). |
| `clear`               | Start a new session with `/clear`.                                                                                 |
| `git-actions`         | Generate and apply commits, branches, and pull requests (`/commit`, `/new-branch`, `/pr`).                         |
| `git-interceptor`     | Prevent interactive Git editor hangs and block `--no-verify`.                                                      |
| `herdr-agent-state`   | Report Pi's fully settled lifecycle state to Herdr when its integration environment is active.                     |
| `pi-claude-agent-sdk` | Expose an opt-in `claude` delegation tool backed by the Claude Agent SDK.                                          |
| `pi-mcp-adapter`      | Discover and invoke MCP tools without loading every tool definition into context.                                  |
| `pi-skill-toggle`     | Manage enabled, hidden, and fully disabled skills with `/skills-toggle`.                                           |
| `pretty-output`       | Provide compact renderers for Pi's built-in tools.                                                                 |
| `review`              | Run structured code reviews through `/review`.                                                                     |
| `save-md`             | Save the latest assistant response with `/save-md`.                                                                |
| `status-bar`          | Show repository, model, usage, cost, and context information.                                                      |
| `subagents`           | Spawn, inspect, await, cancel, and take over Pi, Claude Code, or Codex subagents.                                  |
| `web-tools`           | Register `webfetch` and `websearch`.                                                                               |
| `whimsical`           | Rotate the working message shown during turns.                                                                     |
| `workflows`           | Run model-authored multi-agent workflows and inspect them with `/workflows`.                                       |

The package also includes the `deslop` and `restate` prompt templates and the `github-dark-default` theme.

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
