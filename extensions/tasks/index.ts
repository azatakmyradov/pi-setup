import { StringEnum } from "@earendil-works/pi-ai";
import { glyphs, statusGlyph } from "../shared/ui-kit.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  cloneTaskState,
  completedTaskCount,
  createTasks,
  emptyTaskState,
  formatTaskDetails,
  formatTaskList,
  getTask,
  isTaskStateDetails,
  MAX_COMMENT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TASK_BATCH_SIZE,
  MAX_OWNER_LENGTH,
  MAX_SUBJECT_LENGTH,
  readyTasks,
  restoreTaskStateFromBranch,
  stopTask,
  TASK_STATUSES,
  updateTasks,
  type TaskAction,
  type TaskRecord,
  type TaskState,
  type TaskStateDetails,
} from "./state.ts";

const WIDGET_KEY = "tasks";
const TASK_ID_DESCRIPTION = "Task ID, with or without a leading #.";
const MetadataSchema = Type.Object(
  {},
  {
    additionalProperties: true,
    description: "Optional JSON metadata attached to the task.",
  },
);

function metadataRecord(
  metadata: object | undefined,
): Record<string, unknown> | undefined {
  return metadata ? Object.fromEntries(Object.entries(metadata)) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareTaskCreateArguments(
  args: unknown,
): Static<typeof TaskCreateParams> {
  if (!isRecord(args) || "tasks" in args) {
    return args as Static<typeof TaskCreateParams>;
  }
  if (!("subject" in args) && !("description" in args)) {
    return args as Static<typeof TaskCreateParams>;
  }
  return { tasks: [args] } as Static<typeof TaskCreateParams>;
}

function prepareTaskUpdateArguments(
  args: unknown,
): Static<typeof TaskUpdateParams> {
  if (!isRecord(args) || "updates" in args) {
    return args as Static<typeof TaskUpdateParams>;
  }
  if (!("taskId" in args)) {
    return args as Static<typeof TaskUpdateParams>;
  }
  return { updates: [args] } as Static<typeof TaskUpdateParams>;
}

const TaskCreateItemSchema = Type.Object({
  subject: Type.String({
    minLength: 1,
    maxLength: MAX_SUBJECT_LENGTH,
    description:
      'Brief actionable title in imperative form, such as "Write extension tests".',
  }),
  description: Type.String({
    minLength: 1,
    maxLength: MAX_DESCRIPTION_LENGTH,
    description:
      "Full scope, context, and the verifiable outcome that defines success.",
  }),
  activeForm: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_SUBJECT_LENGTH,
      description:
        'Present-continuous text shown while working, such as "Writing extension tests". Defaults to subject.',
    }),
  ),
  metadata: Type.Optional(MetadataSchema),
});

const TaskCreateParams = Type.Object({
  tasks: Type.Array(TaskCreateItemSchema, {
    minItems: 1,
    maxItems: MAX_TASK_BATCH_SIZE,
    description: "Tasks to create in array order.",
  }),
});

const TaskListParams = Type.Object({});

const TaskGetParams = Type.Object({
  taskId: Type.String({ description: TASK_ID_DESCRIPTION }),
});

const TaskUpdateItemSchema = Type.Object({
  taskId: Type.String({ description: TASK_ID_DESCRIPTION }),
  subject: Type.Optional(
    Type.String({ minLength: 1, maxLength: MAX_SUBJECT_LENGTH }),
  ),
  description: Type.Optional(
    Type.String({ minLength: 1, maxLength: MAX_DESCRIPTION_LENGTH }),
  ),
  activeForm: Type.Optional(
    Type.String({ minLength: 1, maxLength: MAX_SUBJECT_LENGTH }),
  ),
  status: Type.Optional(StringEnum(TASK_STATUSES)),
  comment: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_COMMENT_LENGTH,
      description: "Progress, verification, or blocker note to append.",
    }),
  ),
  addBlocks: Type.Optional(
    Type.Array(Type.String(), {
      description: "Task IDs that this task blocks.",
    }),
  ),
  addBlockedBy: Type.Optional(
    Type.Array(Type.String(), {
      description: "Task IDs that must complete before this task can start.",
    }),
  ),
  owner: Type.Optional(
    Type.String({
      maxLength: MAX_OWNER_LENGTH,
      description: "Agent owner. Pass an empty string to unassign.",
    }),
  ),
  metadata: Type.Optional(MetadataSchema),
});

const TaskUpdateParams = Type.Object({
  updates: Type.Array(TaskUpdateItemSchema, {
    minItems: 1,
    maxItems: MAX_TASK_BATCH_SIZE,
    description: "Task updates to apply atomically in array order.",
  }),
});

const TaskStopParams = Type.Object({
  taskId: Type.String({ description: TASK_ID_DESCRIPTION }),
});

function statusGlyphForTask(status: TaskRecord["status"], theme: Theme): string {
  const state =
    status === "completed" ? "success" : status === "in_progress" ? "running" : "pending";
  return statusGlyph(theme, state);
}

function taskLabel(task: TaskRecord, theme: Theme): string {
  if (task.status === "completed") {
    return theme.fg("dim", theme.strikethrough(task.subject));
  }
  if (task.status === "in_progress") {
    return (
      theme.fg("text", task.subject) + theme.fg("dim", ` — ${task.activeForm}`)
    );
  }
  return theme.fg("text", task.subject);
}

function detailsFor(
  action: TaskAction,
  state: TaskState,
  taskIds: readonly string[] = [],
): TaskStateDetails {
  return {
    version: 2,
    action,
    state: cloneTaskState(state),
    ...(taskIds.length === 1 ? { taskId: taskIds[0] } : {}),
    ...((action === "create" || action === "update") && taskIds.length > 0
      ? { taskIds: [...taskIds] }
      : {}),
  };
}

function toolResultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const block = result.content.find((content) => content.type === "text");
  return block?.text ?? "";
}

function renderTaskResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  expanded: boolean,
  theme: Theme,
): Component {
  const text = toolResultText(result);
  if (!isTaskStateDetails(result.details)) return new Text(text, 0, 0);

  const firstLine = text.split("\n", 1)[0] ?? "";
  let rendered = theme.fg("success", `${glyphs.success} ${firstLine}`);
  if (expanded && result.details.state.tasks.length > 0) {
    for (const task of result.details.state.tasks) {
      rendered += `\n${statusGlyphForTask(task.status, theme)} ${theme.fg("accent", `#${task.id}`)} ${taskLabel(task, theme)}`;
    }
  }
  return new Text(rendered, 0, 0);
}

class TaskListComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly state: TaskState,
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const completed = completedTaskCount(this.state);
    const lines = [
      "",
      truncateToWidth(
        `  ${this.theme.fg("accent", this.theme.bold("Session tasks"))}`,
        width,
      ),
      truncateToWidth(
        `  ${this.theme.fg("muted", `${completed}/${this.state.tasks.length} completed`)}`,
        width,
      ),
      "",
    ];

    for (const task of this.state.tasks) {
      const owner = task.owner
        ? this.theme.fg("dim", ` owner:${task.owner}`)
        : "";
      const blocked = task.blockedBy.length
        ? this.theme.fg(
            "warning",
            ` blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}`,
          )
        : "";
      lines.push(
        truncateToWidth(
          `  ${statusGlyphForTask(task.status, this.theme)} ${this.theme.fg("accent", `#${task.id}`)} ${taskLabel(task, this.theme)}${owner}${blocked}`,
          width,
          "…",
        ),
      );
    }

    lines.push(
      "",
      truncateToWidth(
        `  ${this.theme.fg("dim", "Press Escape to close")}`,
        width,
      ),
      "",
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function updateWidget(ctx: ExtensionContext, state: TaskState): void {
  if (ctx.mode !== "tui") return;
  if (state.tasks.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  const snapshot = cloneTaskState(state);
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
    render(width: number): string[] {
      const completed = completedTaskCount(snapshot);
      const active = snapshot.tasks.filter(
        (task) => task.status === "in_progress",
      );
      const ready = readyTasks(snapshot);

      let progress: string;
      if (active.length > 0) {
        const first = active[0]!;
        const additional =
          active.length > 1 ? theme.fg("dim", ` +${active.length - 1}`) : "";
        progress = `${statusGlyph(theme, "running")} ${theme.fg("accent", `#${first.id}`)} ${theme.fg("text", first.activeForm)}${additional}`;
      } else if (ready.length > 0) {
        const first = ready[0]!;
        progress = `${statusGlyph(theme, "pending")} ${theme.fg("muted", `Next #${first.id}: ${first.subject}`)}`;
      } else if (completed === snapshot.tasks.length) {
        progress = theme.fg("success", `${glyphs.success} Complete`);
      } else {
        progress = theme.fg("warning", "Blocked");
      }

      const line =
        theme.fg("accent", theme.bold("Tasks")) +
        theme.fg("muted", ` ${completed}/${snapshot.tasks.length} · `) +
        progress;
      return [truncateToWidth(line, width, "…")];
    },
    invalidate() {},
  }));
}

export default function tasksExtension(pi: ExtensionAPI): void {
  let state = emptyTaskState();

  const restoreState = (ctx: ExtensionContext): void => {
    state = restoreTaskStateFromBranch(ctx.sessionManager.getBranch());
    updateWidget(ctx, state);
  };

  const commit = (ctx: ExtensionContext, next: TaskState): void => {
    state = cloneTaskState(next);
    updateWidget(ctx, state);
  };

  pi.on("session_start", (_event, ctx) => restoreState(ctx));
  pi.on("session_tree", (_event, ctx) => restoreState(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.registerTool({
    name: "TaskCreate",
    label: "Create Tasks",
    description:
      "Create 1-20 verifiable session tasks atomically in array order. Each task requires an imperative subject and a detailed description of scope and success. Tasks begin pending and receive incrementing IDs.",
    promptSnippet:
      "Create one or more pending tasks with subjects, full descriptions, active wording, and metadata",
    promptGuidelines: [
      "Use TaskCreate for complex implementation work with at least three meaningful steps or work spanning multiple tool calls; do not create tasks for trivial one-step work or pure explanation.",
      "Make every TaskCreate item one verifiable outcome with an imperative subject, detailed scope, and explicit success criteria.",
      "For multi-step work, pass all known work items in one TaskCreate batch before implementation, then use TaskUpdate to start and complete them as reality changes.",
    ],
    parameters: TaskCreateParams,
    prepareArguments: prepareTaskCreateArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("TaskCreate was cancelled.");
      const created = createTasks(
        state,
        params.tasks.map((task) => ({
          ...task,
          metadata: metadataRecord(task.metadata),
        })),
      );
      commit(ctx, created.state);
      const summary =
        created.tasks.length === 1
          ? `Created task #${created.tasks[0]!.id}: ${created.tasks[0]!.subject}`
          : `Created ${created.tasks.length} tasks:\n${created.tasks.map((task) => `- #${task.id}: ${task.subject}`).join("\n")}`;
      const taskIds = created.tasks.map((task) => task.id);
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${formatTaskList(state)}`,
          },
        ],
        details: detailsFor("create", state, taskIds),
      };
    },
    renderCall(args, theme) {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      const detail =
        tasks.length === 1
          ? (tasks[0]?.subject ?? "")
          : tasks.length > 1
            ? `${tasks.length} tasks`
            : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("TaskCreate ")) +
          theme.fg("muted", detail),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      return renderTaskResult(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "List Tasks",
    description:
      "List every current session task with ID, subject, status, owner, and blockers.",
    promptSnippet:
      "List task IDs, subjects, statuses, owners, and blockedBy dependencies",
    promptGuidelines: [
      "Use TaskList after completing or stopping a task when you need to select the next ready task.",
    ],
    parameters: TaskListParams,
    executionMode: "sequential",
    async execute(_toolCallId, _params, signal) {
      if (signal?.aborted) throw new Error("TaskList was cancelled.");
      return {
        content: [{ type: "text", text: formatTaskList(state) }],
        details: detailsFor("list", state),
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("TaskList")), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return renderTaskResult(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "TaskGet",
    label: "Get Task",
    description:
      "Get one task's full description, comments, dependencies, metadata, owner, and timestamps.",
    promptSnippet:
      "Get complete details, comments, dependencies, metadata, and timestamps for one task",
    promptGuidelines: [
      "Use TaskGet when a task's TaskList summary is insufficient to continue safely.",
    ],
    parameters: TaskGetParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("TaskGet was cancelled.");
      const task = getTask(state, params.taskId);
      if (!task) throw new Error(`Task #${params.taskId} not found.`);
      return {
        content: [{ type: "text", text: formatTaskDetails(task) }],
        details: detailsFor("get", state, [task.id]),
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("TaskGet ")) +
          theme.fg("accent", `#${args.taskId}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      return renderTaskResult(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "Update Tasks",
    description:
      "Apply 1-20 task updates atomically in array order. Updates can change fields, owner, status, comments, metadata, or dependency relationships. Pending tasks can start only when blockers are completed; completed tasks must have been in progress.",
    promptSnippet:
      "Apply one or more ordered task status, progress, owner, dependency, metadata, or detail updates",
    promptGuidelines: [
      "Use TaskUpdate to mark tasks in_progress immediately before work begins and completed only after their verifiable outcomes have been checked.",
      "Use TaskUpdate comments for progress, verification evidence, and blockers; use addBlockedBy and addBlocks to record real dependency relationships.",
      "Keep TaskUpdate status aligned with reality: blocked or paused work is pending, active work is in_progress, and only verified work is completed.",
      "When several tasks need changes at the same point, pass their updates together in one ordered TaskUpdate batch.",
    ],
    parameters: TaskUpdateParams,
    prepareArguments: prepareTaskUpdateArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("TaskUpdate was cancelled.");
      const updated = updateTasks(
        state,
        params.updates.map((update) => ({
          ...update,
          metadata: metadataRecord(update.metadata),
        })),
      );
      commit(ctx, updated.state);
      const summaries = updated.updates.map((update) => {
        const statusChange =
          update.previousStatus !== update.task.status
            ? `; ${update.previousStatus} -> ${update.task.status}`
            : "";
        return `#${update.task.id}: ${update.updatedFields.join(", ")}${statusChange}`;
      });
      const summary =
        summaries.length === 1
          ? `Updated task ${summaries[0]}.`
          : `Updated ${summaries.length} tasks:\n${summaries.map((item) => `- ${item}`).join("\n")}`;
      const taskIds = updated.updates.map((update) => update.task.id);
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${formatTaskList(state)}`,
          },
        ],
        details: detailsFor("update", state, taskIds),
      };
    },
    renderCall(args, theme) {
      const updates = Array.isArray(args.updates) ? args.updates : [];
      const update = updates[0];
      const detail =
        updates.length === 1 && update
          ? `#${update.taskId}${update.status ? ` → ${update.status}` : ""}`
          : updates.length > 1
            ? `${updates.length} updates`
            : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("TaskUpdate ")) +
          theme.fg(updates.length === 1 ? "accent" : "muted", detail),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      return renderTaskResult(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "TaskStop",
    label: "Stop Task",
    description:
      "Cancel a pending or in-progress task without completing it. The task is removed and its dependency edges are cleaned up; task IDs are never reused.",
    promptSnippet:
      "Cancel and remove an unfinished task without marking it completed",
    promptGuidelines: [
      "Use TaskStop when an unfinished task is intentionally cancelled or no longer needed; never use TaskUpdate completed for abandoned work.",
    ],
    parameters: TaskStopParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("TaskStop was cancelled.");
      const stopped = stopTask(state, params.taskId);
      commit(ctx, stopped.state);
      return {
        content: [
          {
            type: "text",
            text: `Stopped task #${stopped.task.id}: ${stopped.task.subject}\n\n${formatTaskList(state)}`,
          },
        ],
        details: detailsFor("stop", state, [stopped.task.id]),
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("TaskStop ")) +
          theme.fg("accent", `#${args.taskId}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      return renderTaskResult(result, expanded, theme);
    },
  });

  pi.registerCommand("tasks", {
    description: "Show all tasks for the current session branch",
    handler: async (_args, ctx) => {
      if (state.tasks.length === 0) {
        ctx.ui.notify("No session tasks.", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(formatTaskList(state), "info");
        return;
      }

      const snapshot = cloneTaskState(state);
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) =>
          new TaskListComponent(snapshot, theme, () => done()),
      );
    },
  });
}
