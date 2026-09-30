# Setup

## Install

Pi supports this repository as a local package. Clone it to a stable location, install dependencies, and register the absolute path:

```sh
git clone <repository-url> ~/src/pi-setup
cd ~/src/pi-setup
npm ci
pi install "$PWD"
```

Alternatively, clone or copy the repository directly to `~/.pi/agent` and run `npm ci` there. Pi discovers the conventional `extensions/`, `prompts/`, and `themes/` directories automatically.

Node.js 22.19 or newer and Pi 0.99.1 or newer within the 0.99 release line are required.

## Theme

Select the included theme through `/settings`, or merge this into `~/.pi/agent/settings.json`:

```json
{
  "theme": "github-dark-default"
}
```

## Claude delegation

The Claude extension uses the normal Claude Code authentication available to the process, such as an existing login or `ANTHROPIC_API_KEY`.

> **Security warning:** delegated Claude calls run with `permissionMode: "bypassPermissions"` and `allowDangerouslySkipPermissions: true`. They can modify the selected working tree without an approval prompt or sandbox.

The tool is disabled by default and is enabled for one run only when the user message contains the standalone word `claude`.

## Subagents

The subagents extension can run child agents through Pi, Claude Code, or Codex. Claude Code and Codex use the authentication from their installed CLIs; the Pi backend uses Pi's configured providers. Open `/subagents` to inspect or take over a child agent.

> **Security warning:** subagents run headlessly and can modify their selected working tree. Claude Code uses bypass-permissions mode, and Codex uses `danger-full-access` with approval prompts disabled.

## Run summaries

After each fully settled TUI run, the summaries extension makes a separate model request and appends a recap card with a suggested next step. The card is stored as TUI-only session data and is not sent back to the main agent. Run `/summary-model` to change the default `openai-codex/gpt-5.6-luna` model and medium reasoning level. The private selection is saved in the ignored `extensions/summaries/config.private.json` file.

## MCP

MCP uses Pi's built-in support, including in Pi subagents and workflow children. Configure global servers in `~/.pi/agent/mcp.json` (or `$PI_CODING_AGENT_DIR/mcp.json`) and project servers in `.pi/mcp.json`. Project configuration is read only after the project is trusted. These files and native `mcp-auth.json` credentials are ignored by this repository.

Run `/mcp` to manage servers or `pi mcp list` to check connections. Sign in with `/mcp login <server>` or `pi mcp login <server>`; stored credentials from the removed adapter are not migrated.

When switching from the old adapter, copy required server definitions from `.mcp.json`, `~/.config/mcp/mcp.json`, or imported host configs into Pi's native files. Native Pi does not read those shared files or the adapter's `imports` and `settings` sections. Use `timeout` in seconds instead of `requestTimeoutMs`, and `exposure`/`toolExposure` instead of `directTools`/`excludeTools`. Native MCP supports stdio and streamable HTTP, not legacy SSE or the adapter's MCP Apps UI.

The old `mcp` proxy and `mcp_execute` tool are no longer registered. Native MCP defaults to `codemode` exposure to keep tool definitions out of model context; `tool_search` can discover tools, and tools are named `mcp__<server>__<tool>`. Restart Pi after switching so `/mcp` belongs to the built-in extension.

## Herdr

`extensions/herdr-agent-state.ts` is generated and managed by Herdr. Do not move or edit it manually; reinstalling the integration may overwrite it. The package loads it through `extensions/herdr-agent-state/index.ts`, which adapts the generated integration to Pi's fully settled agent lifecycle so retries, compaction, and queued continuations remain `working`.

## Verify

From a clean checkout, run:

```sh
npm ci
npm run check
npm test
npm run format:check
```

Restart Pi after installation. During development, `/reload` reloads extensions and other package resources.
