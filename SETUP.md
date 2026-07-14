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

Node.js 20 or newer is required.

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

## MCP

The MCP adapter reads standard shared configuration from `.mcp.json` and `~/.config/mcp/mcp.json`. Run `/mcp setup` for interactive discovery and onboarding. Pi-specific overrides belong in `~/.pi/agent/mcp.json` or `.pi/mcp.json`; these files may contain secrets and are ignored by this repository.

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
