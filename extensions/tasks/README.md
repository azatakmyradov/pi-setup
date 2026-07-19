# Tasks extension

Claude Code-style task tracking for multi-step work in Pi. Task state is stored in tool-result details, so resume, fork, and `/tree` navigation restore the correct state for the selected session branch.

## Agent tools

- `TaskCreate` — atomically create 1–20 pending tasks in array order. Each item has an imperative `subject`, full `description`, optional `activeForm`, and JSON `metadata`.
- `TaskList` — list every task with ID, subject, status, owner, and `blockedBy` relationships.
- `TaskGet` — show one task's full description, comments, dependencies, metadata, owner, and timestamps.
- `TaskUpdate` — atomically apply 1–20 ordered updates to task details, owner, status, comments, metadata, or dependency relationships.
- `TaskStop` — cancel and remove an unfinished task without marking it completed; IDs are never reused.

`TaskCreate` and `TaskUpdate` use array-first inputs:

```json
{
  "tasks": [
    {
      "subject": "Implement feature",
      "description": "Implement the feature and define its success criteria."
    },
    {
      "subject": "Write tests",
      "description": "Verify the feature's expected behavior."
    }
  ]
}
```

```json
{
  "updates": [
    { "taskId": "1", "status": "in_progress" },
    { "taskId": "2", "addBlockedBy": ["1"] }
  ]
}
```

Batch items observe earlier items in the same array. A batch is committed only if every item succeeds; an error identifies the failing item and leaves task state unchanged. Items in one batch share a timestamp. Legacy persisted single-item `TaskCreate` and `TaskUpdate` calls are converted to one-item batches before validation.

All five tools execute sequentially, so task calls in one assistant response receive deterministic IDs and observe prior calls.

## Status and dependency rules

- New tasks start `pending`.
- Normal status flow is `pending` → `in_progress` → `completed`.
- An `in_progress` task can be returned to `pending` when paused.
- A task cannot start until all `blockedBy` tasks are completed.
- New blockers can only be attached while the blocked task is pending.
- Dependencies are reciprocal: `A blocks B` also records `B blockedBy A`.
- Dependency cycles and self-dependencies are rejected.
- `completed` is reserved for verified work; abandoned work uses `TaskStop`.

Every mutation returns the complete current task summary to the agent. Create and update results also include all affected IDs in `details.taskIds`; one-item results retain `details.taskId` for compatibility.

## User interface

A compact widget above the editor shows completion progress and the active or next ready task. Run `/tasks` to open the complete task list, including owners and blockers.
