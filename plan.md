Yes. This can be implemented entirely in the existing extension—no Pi core changes.

### Proposed appearance

```text
● Claude Subagent — Map extension architecture  Background
  ↳ Read extensions/subagents/index.ts

✓ Pi Subagent — Map project infrastructure  Done · 18s

✗ Codex Subagent — Map runtime integration  Failed · 7s
```

### Implementation plan

1. **Add an inline chat-row component**
   - Create `extensions/subagents/src/ui/chat-row.ts`.
   - Render compact states: Starting, Background, Done, Cancelled, and Failed.
   - While running, optionally show the latest `liveTools` activity.
   - Truncate output safely to terminal width.

2. **Attach it to `subagent_spawn`**
   - Update `extensions/subagents/index.ts`.
   - Add `renderShell: "self"`, `renderCall`, and `renderResult`.
   - Use the tool row’s shared render state to connect the returned subagent ID to its chat row.
   - Reuse the existing `SubagentReadModel.subscribeTo(id)` API for live updates.

3. **Update efficiently**
   - Call Pi’s `context.invalidate()` when the corresponding snapshot changes.
   - Debounce streaming updates around 50ms, matching the takeover view.
   - Unsubscribe when the subagent settles and clean remaining subscriptions during `session_shutdown`.

4. **Preserve existing behavior**
   - Keep the footer status, `/subagents` dashboard, takeover view, result delivery, `wait`, and `cancel` unchanged.
   - The row reports status; the existing result message still carries the full answer.
   - Restored historical rows should say “Started” rather than falsely appearing active.

5. **Add focused tests**
   - New `extensions/subagents/chat-row.test.ts`.
   - Cover running activity, success, failure, cancellation, width truncation, invalidation, and subscription cleanup.
   - Add it to `extensions/subagents/package.json`.

### Validation

```sh
npm --prefix extensions/subagents test
npm --prefix extensions/subagents run check
npm run check
npm test
npm run format:check
```

OpenCode uses the same basic pattern in `/tmp/opencode/packages/tui/src/routes/session/index.tsx`: a persistent task row reads child-session state and changes from spinner/current activity to completion details. Pi’s custom tool renderer provides the equivalent mechanism.
