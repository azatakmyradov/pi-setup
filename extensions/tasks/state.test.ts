import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneTaskState,
  createTask,
  createTasks,
  emptyTaskState,
  formatTaskDetails,
  formatTaskList,
  getTask,
  MAX_TASK_BATCH_SIZE,
  readyTasks,
  restoreTaskStateFromBranch,
  stopTask,
  updateTask,
  updateTasks,
  type TaskState,
  type TaskStateDetails,
} from "./state.ts";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-01T00:01:00.000Z";

function addTask(
  state: TaskState,
  subject: string,
  description = `${subject} description`,
): TaskState {
  return createTask(state, { subject, description }, T1).state;
}

function details(
  state: TaskState,
  action: TaskStateDetails["action"],
): TaskStateDetails {
  return { version: 2, action, state: cloneTaskState(state) };
}

function toolResult(
  state: TaskState,
  action: TaskStateDetails["action"],
): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "TaskUpdate",
      details: details(state, action),
    },
  };
}

test("TaskCreate assigns incrementing IDs and defaults activeForm to subject", () => {
  const first = createTask(
    emptyTaskState(),
    {
      subject: "  Write tests  ",
      description: "Verify the task extension.",
      metadata: { issue: 42 },
    },
    T1,
  );
  const second = createTask(
    first.state,
    {
      subject: "Document tasks",
      description: "Describe the task tools.",
      activeForm: "Writing task documentation",
    },
    T2,
  );

  assert.equal(first.task.id, "1");
  assert.equal(first.task.status, "pending");
  assert.equal(first.task.activeForm, "Write tests");
  assert.deepEqual(first.task.metadata, { issue: 42 });
  assert.equal(second.task.id, "2");
  assert.equal(second.state.nextId, 3);
  assert.equal(second.task.activeForm, "Writing task documentation");
});

test("TaskCreate validates actionable fields without mutating prior state", () => {
  const state = addTask(emptyTaskState(), "Write tests");

  assert.throws(
    () => createTask(state, { subject: "  ", description: "Valid" }, T2),
    /subject must not be empty/,
  );
  assert.equal(state.tasks.length, 1);
  assert.equal(state.nextId, 2);
});

test("TaskCreate batches assign ordered IDs atomically with one timestamp", () => {
  const original = emptyTaskState();
  const created = createTasks(
    original,
    [
      { subject: "Implement feature", description: "Implement it." },
      { subject: "Write tests", description: "Verify it." },
    ],
    T1,
  );

  assert.deepEqual(
    created.tasks.map((task) => task.id),
    ["1", "2"],
  );
  assert.deepEqual(
    created.tasks.map((task) => task.createdAt),
    [T1, T1],
  );
  assert.deepEqual(original, emptyTaskState());

  assert.throws(
    () =>
      createTasks(
        original,
        [
          { subject: "Valid", description: "Valid task." },
          { subject: "  ", description: "Invalid task." },
        ],
        T2,
      ),
    /TaskCreate item 2 failed: subject must not be empty/,
  );
  assert.deepEqual(original, emptyTaskState());
});

test("task batches enforce the per-call item limit", () => {
  assert.throws(
    () => createTasks(emptyTaskState(), []),
    new RegExp(`between 1 and ${MAX_TASK_BATCH_SIZE}`),
  );
  assert.throws(
    () =>
      updateTasks(
        emptyTaskState(),
        Array.from({ length: MAX_TASK_BATCH_SIZE + 1 }, () => ({
          taskId: "1",
          status: "in_progress" as const,
        })),
      ),
    new RegExp(`between 1 and ${MAX_TASK_BATCH_SIZE}`),
  );
});

test("TaskUpdate enforces real pending to in_progress to completed transitions", () => {
  let state = addTask(emptyTaskState(), "Write tests");

  assert.throws(
    () => updateTask(state, { taskId: "1", status: "completed" }, T2),
    /pending -> completed/,
  );

  state = updateTask(
    state,
    { taskId: "#1", status: "in_progress", owner: "main" },
    T2,
  ).state;
  const completed = updateTask(
    state,
    {
      taskId: "1",
      status: "completed",
      comment: "Verified with focused tests.",
    },
    "2026-01-01T00:02:00.000Z",
  );

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.owner, "main");
  assert.equal(completed.task.completedAt, "2026-01-01T00:02:00.000Z");
  assert.deepEqual(completed.task.comments, [
    {
      content: "Verified with focused tests.",
      createdAt: "2026-01-01T00:02:00.000Z",
    },
  ]);
});

test("TaskUpdate batches are ordered and leave input state unchanged on failure", () => {
  let state = addTask(emptyTaskState(), "Implement feature");
  state = addTask(state, "Write tests");

  const updated = updateTasks(
    state,
    [
      { taskId: "1", status: "in_progress" },
      { taskId: "1", status: "completed" },
      { taskId: "2", addBlockedBy: ["1"] },
      { taskId: "2", status: "in_progress" },
    ],
    T2,
  );
  assert.equal(updated.state.tasks[0]?.status, "completed");
  assert.equal(updated.state.tasks[1]?.status, "in_progress");
  assert.deepEqual(updated.state.tasks[1]?.blockedBy, ["1"]);
  assert.deepEqual(
    updated.updates.map((update) => update.previousStatus),
    ["pending", "in_progress", "pending", "pending"],
  );
  assert.deepEqual(
    state.tasks.map((task) => task.status),
    ["pending", "pending"],
  );

  assert.throws(
    () =>
      updateTasks(
        state,
        [
          { taskId: "1", status: "in_progress" },
          { taskId: "2", status: "completed" },
        ],
        T2,
      ),
    /TaskUpdate item 2 failed: Invalid task status transition/,
  );
  assert.deepEqual(
    state.tasks.map((task) => task.status),
    ["pending", "pending"],
  );
});

test("dependencies are reciprocal and block work until prerequisites complete", () => {
  let state = addTask(emptyTaskState(), "Implement feature");
  state = addTask(state, "Write tests");
  state = updateTask(state, { taskId: "2", addBlockedBy: ["1"] }, T2).state;

  assert.deepEqual(getTask(state, "1")?.blocks, ["2"]);
  assert.equal(getTask(state, "1")?.updatedAt, T2);
  assert.deepEqual(getTask(state, "2")?.blockedBy, ["1"]);
  assert.deepEqual(
    readyTasks(state).map((task) => task.id),
    ["1"],
  );
  assert.throws(
    () => updateTask(state, { taskId: "2", status: "in_progress" }, T2),
    /blocked by #1/,
  );

  state = updateTask(state, { taskId: "1", status: "in_progress" }, T2).state;
  state = updateTask(
    state,
    { taskId: "1", status: "completed" },
    "2026-01-01T00:02:00.000Z",
  ).state;
  assert.deepEqual(
    readyTasks(state).map((task) => task.id),
    ["2"],
  );
});

test("dependencies cannot be added after blocked work has started", () => {
  let state = addTask(emptyTaskState(), "First");
  state = addTask(state, "Second");
  state = updateTask(state, { taskId: "2", status: "in_progress" }, T2).state;

  assert.throws(
    () => updateTask(state, { taskId: "2", addBlockedBy: ["1"] }, T2),
    /Cannot add a blocker.*in_progress/,
  );
  assert.throws(
    () => updateTask(state, { taskId: "1", addBlocks: ["2"] }, T2),
    /Cannot add a blocker.*in_progress/,
  );
});

test("dependency updates reject self references and cycles", () => {
  let state = addTask(emptyTaskState(), "First");
  state = addTask(state, "Second");

  assert.throws(
    () => updateTask(state, { taskId: "1", addBlocks: ["1"] }, T2),
    /cannot depend on or block itself/,
  );

  state = updateTask(state, { taskId: "1", addBlocks: ["2"] }, T2).state;
  assert.throws(
    () => updateTask(state, { taskId: "2", addBlocks: ["1"] }, T2),
    /dependency cycle/,
  );
});

test("reapplying completed with a comment preserves the completion timestamp", () => {
  let state = addTask(emptyTaskState(), "Write tests");
  state = updateTask(state, { taskId: "1", status: "in_progress" }, T2).state;
  state = updateTask(
    state,
    { taskId: "1", status: "completed" },
    "2026-01-01T00:02:00.000Z",
  ).state;

  const commented = updateTask(
    state,
    { taskId: "1", status: "completed", comment: "Verified again." },
    "2026-01-01T00:03:00.000Z",
  );
  assert.equal(commented.task.completedAt, "2026-01-01T00:02:00.000Z");
  assert.deepEqual(commented.updatedFields, ["comment"]);
});

test("metadata safely preserves __proto__ as an own JSON key", () => {
  const metadata = Object.fromEntries([["__proto__", { safe: true }]]);
  const created = createTask(
    emptyTaskState(),
    { subject: "Write tests", description: "Verify behavior.", metadata },
    T1,
  );

  assert.equal(Object.getPrototypeOf(created.task.metadata), Object.prototype);
  assert.deepEqual(created.task.metadata["__proto__"], { safe: true });
  assert.equal(Object.hasOwn(created.task.metadata, "__proto__"), true);
});

test("TaskUpdate appends comments and merges metadata with null deletion", () => {
  let state = createTask(
    emptyTaskState(),
    {
      subject: "Write tests",
      description: "Verify behavior.",
      metadata: { issue: 42, obsolete: true },
    },
    T1,
  ).state;

  const updated = updateTask(
    state,
    {
      taskId: "1",
      description: "Verify behavior and branch restoration.",
      activeForm: "Writing branch tests",
      comment: "Covered the happy path.",
      metadata: { issue: 43, obsolete: null, suite: "focused" },
    },
    T2,
  );

  assert.equal(
    updated.task.description,
    "Verify behavior and branch restoration.",
  );
  assert.equal(updated.task.activeForm, "Writing branch tests");
  assert.deepEqual(updated.task.metadata, { issue: 43, suite: "focused" });
  assert.equal(updated.task.comments[0]?.content, "Covered the happy path.");
});

test("TaskStop removes unfinished tasks, dependency edges, and never reuses IDs", () => {
  let state = addTask(emptyTaskState(), "First");
  state = addTask(state, "Second");
  state = updateTask(state, { taskId: "1", addBlocks: ["2"] }, T2).state;

  const stopped = stopTask(state, "#1", "2026-01-01T00:02:00.000Z");
  assert.equal(stopped.task.subject, "First");
  assert.deepEqual(
    stopped.state.tasks.map((task) => task.id),
    ["2"],
  );
  assert.deepEqual(stopped.state.tasks[0]?.blockedBy, []);
  assert.equal(stopped.state.tasks[0]?.updatedAt, "2026-01-01T00:02:00.000Z");

  const created = createTask(
    stopped.state,
    { subject: "Third", description: "Third task" },
    T2,
  );
  assert.equal(created.task.id, "3");
});

test("TaskStop rejects completed tasks", () => {
  let state = addTask(emptyTaskState(), "Write tests");
  state = updateTask(state, { taskId: "1", status: "in_progress" }, T2).state;
  state = updateTask(
    state,
    { taskId: "1", status: "completed" },
    "2026-01-01T00:02:00.000Z",
  ).state;

  assert.throws(() => stopTask(state, "1"), /completed and cannot be stopped/);
});

test("branch restoration selects the latest valid task snapshot", () => {
  const first = addTask(emptyTaskState(), "First");
  const second = addTask(first, "Second");
  const restored = restoreTaskStateFromBranch([
    toolResult(first, "create"),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "TaskUpdate",
        details: { version: 2, action: "update", state: "invalid" },
      },
    },
    toolResult(second, "create"),
  ]);

  assert.deepEqual(
    restored.tasks.map((task) => task.subject),
    ["First", "Second"],
  );
  second.tasks[0]!.subject = "Mutated";
  assert.equal(restored.tasks[0]?.subject, "First");
});

test("TaskList and TaskGet formatting include the expected context", () => {
  let state = addTask(emptyTaskState(), "Write tests", "Verify behavior.");
  state = updateTask(
    state,
    { taskId: "1", status: "in_progress", owner: "main" },
    T2,
  ).state;
  const task = getTask(state, "1");
  assert.ok(task);

  assert.match(
    formatTaskList(state),
    /#1 \[in_progress\] Write tests owner=main/,
  );
  assert.match(formatTaskDetails(task), /Description: Verify behavior/);
  assert.match(formatTaskDetails(task), /Created: 2026-01-01/);
});
