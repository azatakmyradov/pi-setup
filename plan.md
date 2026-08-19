Yes. I’d treat this as an incremental migration, not a rewrite.

## Goals

1. Move MCP resource ownership, cancellation, concurrency, and errors to Effect.
2. Preserve current behavior:
   - proxy and direct tools
   - lazy/eager/keep-alive lifecycle
   - metadata cache
   - OAuth, sampling, elicitation, MCP UI
   - output guarding
3. Add an optional confined MCP code-mode tool.
4. Keep `index.ts` as a thin Pi integration layer.
5. Keep the vendored adapter easy to sync with upstream.

## Target architecture

```text
Pi extension boundary
  index.ts / commands / renderers
             │
             ▼
       ManagedRuntime
             │
   ┌─────────┼──────────┐
   │         │          │
McpRuntime  Catalog    Auth
   │         │          │
Connections Cache    OAuth storage
   │
Scoped MCP clients/transports
```

The Pi boundary remains async/imperative. Core operations return typed Effects.

```ts
interface McpRuntime {
  status: Effect.Effect<ServerStatus[]>;
  connect(name: string): Effect.Effect<Connection, McpError>;
  disconnect(name: string): Effect.Effect<void, McpError>;
  search(query: SearchQuery): Effect.Effect<ToolMetadata[]>;
  describe(tool: ToolRef): Effect.Effect<ToolMetadata, McpError>;
  call(input: ToolCall): Effect.Effect<McpCallResult, McpError>;
  readResource(input: ResourceCall): Effect.Effect<McpCallResult, McpError>;
}
```

## Phase 1: Characterize existing behavior

Before refactoring:

- Add end-to-end fixture servers for:
  - stdio connection
  - HTTP → SSE fallback
  - tools/list pagination and list-changed notifications
  - tool execution and structured content
  - aborted calls
  - server failure and reconnect
- Add shutdown tests proving no child processes or transports remain.
- Record expected status transitions:
  - disconnected → connecting → connected
  - connected → idle close
  - needs-auth
  - failed with backoff
- Keep the entire existing MCP test suite green.

This creates a behavior contract rather than relying on implementation details.

## Phase 2: Introduce the Effect boundary

Add an adapter-local Effect foundation, following the existing pattern in:

- `extensions/background-terminals/src/runtime.ts`
- `extensions/subagents/src/runtime.ts`

Suggested files:

```text
extensions/pi-mcp-adapter/effect/
  domain.ts
  runtime.ts
  config-service.ts
  catalog-service.ts
  connection-service.ts
  lifecycle-service.ts
  mcp-service.ts
```

Key changes:

- Add tagged errors such as:
  - `UnknownServerError`
  - `ConnectionError`
  - `AuthenticationRequiredError`
  - `ToolCallError`
  - `RequestTimeoutError`
  - `InvalidToolArgumentsError`
- Create one `ManagedRuntime` per Pi session.
- Dispose it during `session_shutdown`.
- Bridge Pi’s `AbortSignal` to Effect interruption.
- Convert typed failures to Pi tool errors only at the outer boundary.

Do not Effect-wrap pure formatting, config merging, schemas, or TUI rendering.

## Phase 3: Move connection ownership to Effect

Replace `McpServerManager` incrementally.

### Resource handling

Each connected client/transport becomes a scoped resource:

```text
acquire transport
→ create client
→ connect
→ fetch metadata
→ register notifications
→ use
→ close client and transport through scope finalizer
```

Use Effect primitives for:

- `Ref` for connection state
- `Deferred` for concurrent-connect deduplication
- scoped resources for clients/transports
- `Semaphore` for bounded startup connection concurrency
- supervised fibers for health and idle checks

Preserve:

- npx binary resolution
- stdio and HTTP transports
- Streamable HTTP → SSE fallback
- request timeout behavior
- sampling and elicitation handlers
- MCP stream notifications

Exit criterion: `server-manager.ts` is either a compatibility facade or deleted.

## Phase 4: Move lifecycle and catalog state

Replace `McpLifecycleManager`’s raw timers and mutable maps.

- Use scoped fibers instead of `setInterval`.
- Use a clock service so idle and backoff behavior can be tested without sleeping.
- Keep current semantics:
  - lazy by default
  - eager startup
  - keep-alive reconnect
  - project-remembered servers
  - in-flight calls prevent idle shutdown
  - 60-second connection failure backoff
- Wrap metadata persistence behind a service.
- Keep the current cache format initially to avoid migration risk.
- Emit catalog/status events after reconnect or tool-list changes.

At this point, `proxy-modes.ts` and `direct-tools.ts` should both call the same `McpRuntime.call()` path.

## Phase 5: Migrate auth and UI integrations

Move orchestration into Effects while leaving Pi dialogs and renderers at the edge.

- OAuth token storage and callback server become scoped services.
- Browser opening and Pi dialogs are injected capabilities.
- Sampling and elicitation receive narrow host interfaces.
- MCP UI sessions use the shared call path rather than directly accessing clients.
- Ensure interruption closes pending callback listeners and UI streams.

Avoid teaching the core service about Pi’s TUI component types.

## Phase 6: Add MCP code mode

### Tool interface

Add an opt-in tool named `mcp_code` rather than generic `execute`, avoiding collisions with other extensions.

```ts
mcp_code({
  code: `
    const repos = await tools.github.search_repositories({ query: "effect ts" })
    return repos.items.map(x => ({ name: x.name, stars: x.stars }))
  `,
});
```

The tool tree should be:

```text
tools.<server>.<tool>
tools.$codemode.search(...)
```

Catalog entries come from the existing metadata cache, so code mode keeps the adapter’s lazy-connect advantage. A child call goes through `McpRuntime.call()` and therefore inherits:

- lazy connection
- OAuth behavior
- exclusions
- timeouts
- output guards
- URL elicitation
- cancellation
- logging

### Configuration

```json
{
  "settings": {
    "codeMode": {
      "enabled": true,
      "catalogBudget": 2000,
      "timeoutMs": 60000,
      "maxToolCalls": 20,
      "maxOutputBytes": 51200
    }
  }
}
```

Also accept `"codeMode": true` with safe defaults. Keep it disabled by default initially.

Proxy, direct, and code modes should coexist. Hiding the proxy can remain an explicit configuration choice rather than an automatic consequence of enabling code mode.

### Interpreter choice

Do **not** use `eval`, `Function`, or Node’s `vm`.

Recommended approach:

1. Vendor opencode’s MIT-licensed `@opencode-ai/codemode` at a pinned commit.
2. Put it in an isolated directory such as:

```text
extensions/pi-mcp-adapter/vendor/opencode-codemode/
  LICENSE
  UPSTREAM.md
  package.json
  src/
```

3. Keep Pi-specific integration outside that directory.
4. Exclude its OpenAPI support initially; only vendor the interpreter/tool runtime.
5. Port it to this repository’s Effect version (`4.0.0-beta.98`) with documented patches.
6. Bring across its sandbox, interruption, discovery, and parity tests.

The opencode package is currently private and uses Effect `4.0.0-beta.83`, so it cannot simply be installed unchanged.

### Code-mode result handling

- Stream child-call progress through Pi’s `onUpdate`.
- Include child call names/statuses in result `details`.
- Return structured JSON when possible.
- Pass images through as Pi image blocks.
- Apply the existing MCP output guard to aggregated text.
- Sanitize internal failures before exposing them to the model.
- Initially exclude or explicitly test UI-bearing tools; nested interactive UIs are the most complicated case.

## Phase 7: Remove compatibility layers

After every caller uses `McpRuntime`:

- Delete legacy mutable managers.
- Reduce `McpExtensionState` to Pi-facing UI/session data plus the Effect runtime.
- Make `index.ts` responsible only for:
  - early config/cache reading
  - registering tools and commands
  - creating/disposing the session runtime
  - adapting Effect results to Pi results

## Suggested PR sequence

1. **Characterization tests and Effect runtime shell**
2. **Scoped transport/connection service**
3. **Lifecycle, catalog, and cache services**
4. **Proxy/direct tools migrated to `McpRuntime`**
5. **OAuth, sampling, elicitation, and UI migration**
6. **Vendored confined interpreter**
7. **`mcp_code` integration and documentation**
8. **Legacy cleanup**

Each PR should leave all existing modes usable.

## Critical acceptance tests

- Concurrent calls cause only one connection attempt.
- Aborting `mcp_code` interrupts all child calls.
- Session shutdown closes every client, process, timer/fiber, and callback server.
- Infinite code loops hit the code-mode timeout.
- `eval`, imports, `process`, filesystem, and ambient network are unavailable.
- `maxToolCalls` and output limits are enforced.
- Lazy servers remain disconnected during catalog search.
- OAuth-required tools return actionable, sanitized failures.
- Direct, proxy, and code-mode calls produce equivalent MCP results.
- Metadata-cache/config formats remain backward compatible.
- Full verification:

```sh
npm --prefix extensions/pi-mcp-adapter test
npm run check
npm test
npm run format:check
```

The main architectural rule should be: **Effect owns asynchronous resources and failure semantics; Pi owns registration, UI, and rendering; every access mode calls the same MCP service.**
