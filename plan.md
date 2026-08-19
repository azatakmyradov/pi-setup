## Plan: update repo to Pi 0.84.2

Current state: global Pi is already `0.84.2`; repository dependencies resolve to `0.80.x`.

1. **Align dependencies**
   - Update root `package-lock.json` to Pi AI, coding agent, and TUI `0.84.2`, with Pi-compatible TypeBox `1.3.7`.
   - Keep the root wildcard peer dependencies unchanged.
   - Update `extensions/pi-mcp-adapter/package.json` and its lockfile from Pi `0.74/0.79` ranges to `^0.84.2`.

2. **Migrate removed SDK APIs**
   - In `extensions/subagents/src/backends/pi.ts` and `extensions/workflows/runner.ts`, remove the unsupported `modelRegistry` option passed to `createAgentSession()`.
   - Let child sessions initialize the supported `ModelRuntime` from the existing agent directory and resources.
   - Remove resulting unused workflow plumbing from `extensions/workflows/index.ts`.
   - In `extensions/save-md/test/save-md.test.ts`, replace removed `AuthStorage` and `ModelRegistry.inMemory()` with `ModelRuntime`, `InMemoryCredentialStore`, and a constructed `ModelRegistry`.

3. **Update the MCP adapter**
   - Change `complete` in `extensions/pi-mcp-adapter/sampling-handler.ts` to import from `@earendil-works/pi-ai/compat`.
   - Update the corresponding Vitest mock path.
   - Type resolved headers as `ProviderHeaders` so Pi 0.84’s nullable header-deletion markers pass through unchanged.
   - Adjust the existing sampling test to cover a nullable header.

4. **Validate**
   - Verify all Pi packages resolve to `0.84.2` with `npm ls`.
   - Run:
     ```sh
     npm run check
     npm test
     npm run format:check
     ```
   - Run the MCP adapter’s TypeScript check and sampling tests directly while iterating.

I tested the core migration in an isolated copy: TypeScript checking, the full root suite, all 448 MCP tests, and formatting passed.
