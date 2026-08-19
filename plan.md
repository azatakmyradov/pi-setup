Yes. Proposed plan:

1. **Define code-mode tool surface**
   - When `settings.codeMode.enabled === true` or `settings.codeMode === true`, hide model-facing normal MCP tools:
     - Do not register proxy tool `mcp`.
     - Do not register direct MCP tools.
   - Keep `/mcp` commands, MCP panel, auth commands, lifecycle, and cache behavior for user/admin access.

2. **Rename tool**
   - Register `mcp_execute` instead of `mcp_code`.
   - Update labels, descriptions, README, tests, and examples.
   - Recommendation: no default `mcp_code` alias, to avoid exposing duplicate MCP surfaces.

3. **Wire discovery through `mcp_execute`**
   - Keep OpenCode-style internal search:
     ```js
     return await tools.$codemode.search({ query: "github issues" });
     ```
   - Ensure it is always callable from inside `mcp_execute`, even when the inline catalog is complete.
   - Search should use current cached MCP metadata and exclude hidden/UI tools.

4. **Surface OpenCode-style instructions**
   - Replace the current short `mcp_execute` description with `CodeMode.runtime.instructions()`.
   - Include:
     - `## Workflow`
     - `## Rules`
     - `## Language`
     - `## Available tools`
   - Add Pi-specific notes: child calls use lazy MCP connect, OAuth, cancellation, timeouts, output guard, and no ambient network/filesystem/process access.

5. **Handle catalog bootstrapping**
   - Build the initial `mcp_execute` instructions from early cached metadata.
   - Runtime search uses live `state.toolMetadata`.
   - If no cached metadata exists for a configured lazy server, search should clearly say no tools are known yet and suggest `/mcp reconnect <server>` or MCP panel refresh.

6. **Tests**
   - Code mode enabled registers `mcp_execute` only; no `mcp` proxy/direct MCP tools.
   - `mcp_execute` description contains OpenCode sections and searchable tool signatures.
   - Internal `tools.$codemode.search` returns callable paths.
   - Search excludes UI-bearing/excluded tools.
   - Rename tests from `mcp_code` to `mcp_execute`.

7. **Validation**
   - `npx tsc -p extensions/pi-mcp-adapter/tsconfig.json --noEmit`
   - `npm --prefix extensions/pi-mcp-adapter test`
   - `npm run check`
   - `npm test`
   - `npm run format:check`

Main files to touch: `extensions/pi-mcp-adapter/index.ts`, `code-mode.ts`, README, and code-mode/lifecycle tests.
