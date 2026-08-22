import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import tasksExtension from "./index.ts";
import {
  cloneTaskState,
  createTask,
  emptyTaskState,
  type CreateTaskInput,
  type TaskState,
  type TaskStateDetails,
  type TaskStatus,
  type UpdateTaskInput,
} from "./state.ts";

/** The theme and TUI capabilities the task views actually use. */
type TestTheme = Pick<Theme, "fg" | "bold" | "strikethrough">;
type TestTui = Pick<TUI, "requestRender">;

/** The task views bind no app keybindings. */
type UnusedKeybindings = Record<never, never>;

interface TestToolResult {
  content: Array<{ type: string; text: string }>;
  details: TaskStateDetails;
}

/** Arguments these tests hand to the task tools, mirroring the registered schemas. */
interface TaskToolArguments {
  tasks?: CreateTaskInput[];
  updates?: UpdateTaskInput[];
  taskId?: string;
  subject?: string;
  description?: string;
  status?: TaskStatus;
}

interface TestTool {
  name: string;
  executionMode?: string;
  promptGuidelines?: string[];
  parameters?: TSchema;
  prepareArguments?(args: TaskToolArguments): TaskToolArguments;
  execute(
    toolCallId: string,
    params: TaskToolArguments,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: TestContext,
  ): Promise<TestToolResult>;
}

interface TestCommand {
  handler(args: string, ctx: TestContext): Promise<void>;
}

type EventHandler = (event: undefined, ctx: TestContext) => void | Promise<void>;

/** The widget the extension registers: a factory over the TUI and theme. */
type WidgetFactory = (tui: TestTui, theme: TestTheme) => Component;

/** The full-screen task list, built by the same factory contract as `ui.custom`. */
type TaskViewFactory<T> = (
  tui: TestTui,
  theme: TestTheme,
  keybindings: UnusedKeybindings,
  done: (result: T) => void,
) => Component;

interface WidgetCall {
  key: string;
  content: WidgetFactory | undefined;
}

interface TestContext {
  mode: string;
  hasUI: boolean;
  sessionManager: { getBranch(): readonly unknown[] };
  ui: {
    setWidget(key: string, content: WidgetFactory | undefined): void;
    notify(message: string): void;
    custom<T>(factory: TaskViewFactory<T>): Promise<T>;
  };
}

function persisted(state: TaskState, action: TaskStateDetails["action"]) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "TaskUpdate",
      details: {
        version: 2,
        action,
        state: cloneTaskState(state),
      } satisfies TaskStateDetails,
    },
  };
}

function createContext(entries: readonly unknown[] = [], mode = "tui") {
  const widgets: WidgetCall[] = [];
  const notifications: string[] = [];
  const context: TestContext = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager: { getBranch: () => entries },
    ui: {
      setWidget(key, content) {
        widgets.push({ key, content });
      },
      notify(message) {
        notifications.push(message);
      },
      custom() {
        throw new Error("custom UI was not expected in this test");
      },
    },
  };
  return { context, widgets, notifications };
}

function createHarness() {
  const handlers = new Map<string, EventHandler>();
  const tools = new Map<string, TestTool>();
  let command: TestCommand | undefined;

  // SAFETY: the tasks extension only calls on, registerTool, and registerCommand,
  // and this recorder implements exactly those three; no test path reaches the rest
  // of the ExtensionAPI surface.
  const pi = {
    // `on` is thirty-plus overloads deep, so the recorder claims nothing about the
    // handler type it is given; the tests invoke what it stored as an EventHandler.
    on(event: string, handler: never) {
      handlers.set(event, handler);
    },
    registerTool(definition: TestTool) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: TestCommand) {
      if (name === "tasks") command = definition;
    },
  } as ExtensionAPI;

  tasksExtension(pi);
  if (!command) throw new Error("tasks command was not registered");
  return { handlers, tools, command };
}

function requiredTool(tools: Map<string, TestTool>, name: string): TestTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} was not registered`);
  return tool;
}

const theme: TestTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

test("registers the five task tools sequentially with bounded batch schemas", () => {
  const { tools } = createHarness();

  assert.deepEqual(
    [...tools.keys()],
    ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskStop"],
  );
  for (const tool of tools.values()) {
    assert.equal(tool.executionMode, "sequential");
  }
  assert.ok(
    requiredTool(tools, "TaskCreate").promptGuidelines?.some((line) =>
      line.includes("verifiable outcome"),
    ),
  );

  const createSchema = JSON.stringify(requiredTool(tools, "TaskCreate").parameters);
  const updateSchema = JSON.stringify(requiredTool(tools, "TaskUpdate").parameters);
  assert.match(createSchema, /"tasks"/);
  assert.match(updateSchema, /"updates"/);
  for (const schema of [createSchema, updateSchema]) {
    assert.match(schema, /"minItems":1/);
    assert.match(schema, /"maxItems":20/);
    assert.doesNotMatch(schema, /patternProperties/);
    assert.match(schema, /additionalProperties/);
  }
});

test("legacy single-item arguments are prepared as one-item batches", () => {
  const { tools } = createHarness();
  const create = requiredTool(tools, "TaskCreate");
  const update = requiredTool(tools, "TaskUpdate");

  assert.deepEqual(
    create.prepareArguments?.({
      subject: "Write tests",
      description: "Verify batching.",
    }),
    {
      tasks: [{ subject: "Write tests", description: "Verify batching." }],
    },
  );
  assert.deepEqual(update.prepareArguments?.({ taskId: "1", status: "in_progress" }), {
    updates: [{ taskId: "1", status: "in_progress" }],
  });

  const currentCreate = { tasks: [] };
  const currentUpdate = { updates: [] };
  assert.equal(create.prepareArguments?.(currentCreate), currentCreate);
  assert.equal(update.prepareArguments?.(currentUpdate), currentUpdate);
});

test("create, update, list, and get expose the full current task context", async () => {
  const { tools } = createHarness();
  const { context, widgets } = createContext();
  const create = requiredTool(tools, "TaskCreate");
  const update = requiredTool(tools, "TaskUpdate");
  const list = requiredTool(tools, "TaskList");
  const get = requiredTool(tools, "TaskGet");

  const created = await create.execute(
    "create-1",
    {
      tasks: [
        {
          subject: "Write tests",
          description: "Verify the task extension.",
          activeForm: "Writing tests",
        },
      ],
    },
    undefined,
    undefined,
    context,
  );
  assert.match(created.content[0]?.text ?? "", /Created task #1/);
  assert.equal(created.details.state.tasks[0]?.status, "pending");

  const updated = await update.execute(
    "update-1",
    { updates: [{ taskId: "1", status: "in_progress", owner: "main" }] },
    undefined,
    undefined,
    context,
  );
  assert.match(updated.content[0]?.text ?? "", /pending -> in_progress/);
  assert.match(updated.content[0]?.text ?? "", /#1 \[in_progress\]/);

  const listed = await list.execute("list", {}, undefined, undefined, context);
  assert.match(listed.content[0]?.text ?? "", /owner=main/);

  const detail = await get.execute("get", { taskId: "#1" }, undefined, undefined, context);
  assert.match(detail.content[0]?.text ?? "", /Description: Verify the task extension/);
  assert.match(detail.content[0]?.text ?? "", /Owner: main/);

  const widgetFactory = widgets.at(-1)?.content;
  assert.ok(widgetFactory);
  const component = widgetFactory({ requestRender() {} }, theme);
  assert.match(component.render(120)[0], /Tasks 0\/1.*#1 Writing tests/);
});

test("multiple creates receive deterministic IDs and TaskStop removes dependencies", async () => {
  const { tools } = createHarness();
  const { context } = createContext();
  const create = requiredTool(tools, "TaskCreate");
  const update = requiredTool(tools, "TaskUpdate");
  const stop = requiredTool(tools, "TaskStop");

  const created = await create.execute(
    "create-batch",
    {
      tasks: [
        { subject: "Implement feature", description: "Implement it." },
        { subject: "Write tests", description: "Verify it." },
      ],
    },
    undefined,
    undefined,
    context,
  );
  assert.match(created.content[0]?.text ?? "", /Created 2 tasks/);
  assert.deepEqual(
    created.details.state.tasks.map((task) => task.id),
    ["1", "2"],
  );
  assert.deepEqual(created.details.taskIds, ["1", "2"]);
  assert.equal(created.details.taskId, undefined);

  await update.execute(
    "dependency",
    { updates: [{ taskId: "2", addBlockedBy: ["1"] }] },
    undefined,
    undefined,
    context,
  );
  const stopped = await stop.execute("stop", { taskId: "1" }, undefined, undefined, context);

  assert.match(stopped.content[0]?.text ?? "", /Stopped task #1/);
  assert.deepEqual(
    stopped.details.state.tasks.map((task) => task.id),
    ["2"],
  );
  assert.deepEqual(stopped.details.state.tasks[0]?.blockedBy, []);
  assert.equal(stopped.details.state.nextId, 3);
});

test("TaskUpdate batches commit once and roll back completely on failure", async () => {
  const { tools } = createHarness();
  const { context, widgets } = createContext();
  const create = requiredTool(tools, "TaskCreate");
  const update = requiredTool(tools, "TaskUpdate");
  const list = requiredTool(tools, "TaskList");

  await create.execute(
    "create",
    {
      tasks: [
        { subject: "Implement feature", description: "Implement it." },
        { subject: "Write tests", description: "Verify it." },
      ],
    },
    undefined,
    undefined,
    context,
  );
  const updated = await update.execute(
    "start-batch",
    {
      updates: [
        { taskId: "1", status: "in_progress" },
        { taskId: "2", status: "in_progress" },
      ],
    },
    undefined,
    undefined,
    context,
  );

  assert.match(updated.content[0]?.text ?? "", /Updated 2 tasks/);
  assert.deepEqual(updated.details.taskIds, ["1", "2"]);
  assert.equal(widgets.length, 2);

  await assert.rejects(
    update.execute(
      "invalid-batch",
      {
        updates: [
          { taskId: "1", status: "completed" },
          { taskId: "2", addBlockedBy: ["999"] },
        ],
      },
      undefined,
      undefined,
      context,
    ),
    /TaskUpdate item 2 failed: Task #999 not found/,
  );
  assert.equal(widgets.length, 2);

  const current = await list.execute("list", {}, undefined, undefined, context);
  assert.deepEqual(
    current.details.state.tasks.map((task) => task.status),
    ["in_progress", "in_progress"],
  );
});

test("failed single-item updates leave state unchanged", async () => {
  const { tools } = createHarness();
  const { context } = createContext();
  const create = requiredTool(tools, "TaskCreate");
  const update = requiredTool(tools, "TaskUpdate");
  const list = requiredTool(tools, "TaskList");

  await create.execute(
    "create",
    { tasks: [{ subject: "Write tests", description: "Verify behavior." }] },
    undefined,
    undefined,
    context,
  );
  await assert.rejects(
    update.execute(
      "invalid",
      { updates: [{ taskId: "1", status: "completed" }] },
      undefined,
      undefined,
      context,
    ),
    /pending -> completed/,
  );

  const current = await list.execute("list", {}, undefined, undefined, context);
  assert.equal(current.details.state.tasks[0]?.status, "pending");
});

test("session lifecycle restores the selected branch snapshot", async () => {
  const { handlers, tools } = createHarness();
  const first = createTask(
    emptyTaskState(),
    { subject: "First", description: "First task" },
    "2026-01-01T00:00:00.000Z",
  ).state;
  const second = createTask(
    emptyTaskState(),
    { subject: "Second", description: "Second task" },
    "2026-01-01T00:00:00.000Z",
  ).state;
  const initial = createContext([persisted(first, "create")]);
  const alternate = createContext([persisted(second, "create")]);

  await handlers.get("session_start")?.(undefined, initial.context);
  await handlers.get("session_tree")?.(undefined, alternate.context);
  const listed = await requiredTool(tools, "TaskList").execute(
    "list",
    {},
    undefined,
    undefined,
    alternate.context,
  );

  assert.match(listed.content[0]?.text ?? "", /Second/);
  assert.doesNotMatch(listed.content[0]?.text ?? "", /First/);
});

test("TUI /tasks renders IDs, owners, and blockers and closes on Escape", async () => {
  const { tools, command } = createHarness();
  const initial = createContext();
  const create = requiredTool(tools, "TaskCreate");
  const update = requiredTool(tools, "TaskUpdate");

  await create.execute(
    "create-1",
    {
      tasks: [{ subject: "Implement feature", description: "Implement it." }],
    },
    undefined,
    undefined,
    initial.context,
  );
  await create.execute(
    "create-2",
    { tasks: [{ subject: "Write tests", description: "Verify it." }] },
    undefined,
    undefined,
    initial.context,
  );
  await update.execute(
    "update",
    {
      updates: [{ taskId: "2", addBlockedBy: ["1"], owner: "main" }],
    },
    undefined,
    undefined,
    initial.context,
  );

  let rendered: string[] = [];
  let closed = false;
  const context: TestContext = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget() {},
      notify() {},
      custom(factory) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, (result) => {
            closed = true;
            resolve(result);
          });
          rendered = component.render(120);
          component.handleInput?.("\u001b");
        });
      },
    },
  };

  await command.handler("", context);

  const text = rendered.join("\n");
  assert.match(text, /Session tasks/);
  assert.match(text, /#2 Write tests owner:main blocked by #1/);
  assert.equal(closed, true);
});

test("non-TUI /tasks falls back to a full list notification", async () => {
  const { tools, command } = createHarness();
  const initial = createContext();
  await requiredTool(tools, "TaskCreate").execute(
    "create",
    { tasks: [{ subject: "Write tests", description: "Verify behavior." }] },
    undefined,
    undefined,
    initial.context,
  );

  const rpc = createContext([], "rpc");
  await command.handler("", rpc.context);
  assert.match(rpc.notifications[0] ?? "", /#1 \[pending\] Write tests/);
});
