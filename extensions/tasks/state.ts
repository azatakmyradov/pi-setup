export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TaskMetadata = Record<string, JsonValue>;

export interface TaskComment {
  content: string;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  comments: TaskComment[];
  metadata: TaskMetadata;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TaskState {
  tasks: TaskRecord[];
  nextId: number;
}

export type TaskAction = "create" | "list" | "get" | "update" | "stop";

export interface TaskStateDetails {
  version: 2;
  action: TaskAction;
  state: TaskState;
  taskId?: string;
  taskIds?: string[];
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  comment?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export const MAX_TASKS = 100;
export const MAX_TASK_BATCH_SIZE = 20;
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 4_000;
export const MAX_COMMENT_LENGTH = 2_000;
export const MAX_COMMENTS_PER_TASK = 50;
export const MAX_OWNER_LENGTH = 100;
export const MAX_TASK_STATE_BYTES = 40 * 1024;

const TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
  "TaskStop",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSingleLine(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function normalizeLongText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

function requireText(
  value: string,
  field: string,
  maxLength: number,
  multiline = false,
): string {
  const normalized = multiline
    ? normalizeLongText(value)
    : normalizeSingleLine(value);
  if (!normalized) throw new Error(`${field} must not be empty.`);
  if (normalized.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    TASK_STATUSES.some((status) => status === value)
  );
}

function normalizeTaskId(value: string): string {
  const id = value.trim().replace(/^#/, "");
  if (!/^\d+$/.test(id) || Number(id) < 1) {
    throw new Error(`Invalid task ID: ${value}`);
  }
  return String(Number(id));
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 10) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function setMetadataValue(
  metadata: TaskMetadata,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(metadata, key, {
    value: structuredClone(value),
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined,
): TaskMetadata {
  if (!metadata) return {};
  const normalized: TaskMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = normalizeSingleLine(key);
    if (!normalizedKey) throw new Error("Metadata keys must not be empty.");
    if (!isJsonValue(value)) {
      throw new Error(`Metadata value for ${normalizedKey} must be JSON.`);
    }
    setMetadataValue(normalized, normalizedKey, value);
  }
  return normalized;
}

export function emptyTaskState(): TaskState {
  return { tasks: [], nextId: 1 };
}

export function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    comments: task.comments.map((comment) => ({ ...comment })),
    metadata: structuredClone(task.metadata),
  };
}

export function cloneTaskState(state: TaskState): TaskState {
  return {
    tasks: state.tasks.map(cloneTask),
    nextId: state.nextId,
  };
}

function findTask(state: TaskState, taskId: string): TaskRecord {
  const id = normalizeTaskId(taskId);
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task #${id} not found.`);
  return task;
}

export function getTask(
  state: TaskState,
  taskId: string,
): TaskRecord | undefined {
  const id = normalizeTaskId(taskId);
  const task = state.tasks.find((candidate) => candidate.id === id);
  return task ? cloneTask(task) : undefined;
}

function ensureStateSize(state: TaskState): void {
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_TASK_STATE_BYTES) {
    throw new Error(
      `Task state exceeds ${MAX_TASK_STATE_BYTES} bytes. Complete, stop, or shorten tasks before adding more detail.`,
    );
  }
}

function taskIds(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map(normalizeTaskId))];
}

function ensureDependenciesExist(
  state: TaskState,
  taskId: string,
  dependencyIds: readonly string[],
): void {
  for (const dependencyId of dependencyIds) {
    if (dependencyId === taskId) {
      throw new Error(`Task #${taskId} cannot depend on or block itself.`);
    }
    findTask(state, dependencyId);
  }
}

function ensureAcyclic(state: TaskState): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      throw new Error(`Task dependency cycle detected at #${taskId}.`);
    }
    if (visited.has(taskId)) return;

    visiting.add(taskId);
    const task = findTask(state, taskId);
    for (const blockedId of task.blocks) visit(blockedId);
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of state.tasks) visit(task.id);
}

function incompleteBlockers(state: TaskState, task: TaskRecord): TaskRecord[] {
  return task.blockedBy
    .map((id) => findTask(state, id))
    .filter((blocker) => blocker.status !== "completed");
}

export function createTask(
  current: TaskState,
  input: CreateTaskInput,
  now = new Date().toISOString(),
): { state: TaskState; task: TaskRecord } {
  if (current.tasks.length >= MAX_TASKS) {
    throw new Error(`TaskCreate accepts at most ${MAX_TASKS} active tasks.`);
  }

  const state = cloneTaskState(current);
  const subject = requireText(input.subject, "subject", MAX_SUBJECT_LENGTH);
  const task: TaskRecord = {
    id: String(state.nextId),
    subject,
    description: requireText(
      input.description,
      "description",
      MAX_DESCRIPTION_LENGTH,
      true,
    ),
    activeForm: input.activeForm
      ? requireText(input.activeForm, "activeForm", MAX_SUBJECT_LENGTH)
      : subject,
    status: "pending",
    blocks: [],
    blockedBy: [],
    comments: [],
    metadata: normalizeMetadata(input.metadata),
    createdAt: now,
    updatedAt: now,
  };

  state.nextId++;
  state.tasks.push(task);
  ensureStateSize(state);
  return { state, task: cloneTask(task) };
}

function requireBatchSize(toolName: string, itemCount: number): void {
  if (itemCount < 1 || itemCount > MAX_TASK_BATCH_SIZE) {
    throw new Error(
      `${toolName} accepts between 1 and ${MAX_TASK_BATCH_SIZE} items per call.`,
    );
  }
}

function batchItemError(
  toolName: string,
  index: number,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${toolName} item ${index + 1} failed: ${message}`);
}

export function createTasks(
  current: TaskState,
  inputs: readonly CreateTaskInput[],
  now = new Date().toISOString(),
): { state: TaskState; tasks: TaskRecord[] } {
  requireBatchSize("TaskCreate", inputs.length);

  let state = current;
  const tasks: TaskRecord[] = [];
  for (const [index, input] of inputs.entries()) {
    try {
      const created = createTask(state, input, now);
      state = created.state;
      tasks.push(created.task);
    } catch (error) {
      throw batchItemError("TaskCreate", index, error);
    }
  }

  return { state, tasks };
}

function ensureStatusTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (from === "pending" && to === "in_progress") return;
  if (from === "in_progress" && (to === "pending" || to === "completed")) {
    return;
  }
  throw new Error(`Invalid task status transition: ${from} -> ${to}.`);
}

export function updateTask(
  current: TaskState,
  input: UpdateTaskInput,
  now = new Date().toISOString(),
): { state: TaskState; task: TaskRecord; updatedFields: string[] } {
  const state = cloneTaskState(current);
  const task = findTask(state, input.taskId);
  const updatedFields: string[] = [];

  if (input.subject !== undefined) {
    task.subject = requireText(input.subject, "subject", MAX_SUBJECT_LENGTH);
    updatedFields.push("subject");
  }
  if (input.description !== undefined) {
    task.description = requireText(
      input.description,
      "description",
      MAX_DESCRIPTION_LENGTH,
      true,
    );
    updatedFields.push("description");
  }
  if (input.activeForm !== undefined) {
    task.activeForm = requireText(
      input.activeForm,
      "activeForm",
      MAX_SUBJECT_LENGTH,
    );
    updatedFields.push("activeForm");
  }
  if (input.owner !== undefined) {
    const owner = normalizeSingleLine(input.owner);
    if (owner.length > MAX_OWNER_LENGTH) {
      throw new Error(`owner exceeds ${MAX_OWNER_LENGTH} characters.`);
    }
    if (owner) task.owner = owner;
    else delete task.owner;
    updatedFields.push("owner");
  }
  if (input.comment !== undefined) {
    if (task.comments.length >= MAX_COMMENTS_PER_TASK) {
      throw new Error(
        `Task #${task.id} already has ${MAX_COMMENTS_PER_TASK} comments.`,
      );
    }
    task.comments.push({
      content: requireText(input.comment, "comment", MAX_COMMENT_LENGTH, true),
      createdAt: now,
    });
    updatedFields.push("comment");
  }
  if (input.metadata !== undefined) {
    for (const [key, value] of Object.entries(input.metadata)) {
      const normalizedKey = normalizeSingleLine(key);
      if (!normalizedKey) throw new Error("Metadata keys must not be empty.");
      if (value === null) delete task.metadata[normalizedKey];
      else {
        if (!isJsonValue(value)) {
          throw new Error(`Metadata value for ${normalizedKey} must be JSON.`);
        }
        setMetadataValue(task.metadata, normalizedKey, value);
      }
    }
    updatedFields.push("metadata");
  }

  const blocks = taskIds(input.addBlocks);
  const blockedBy = taskIds(input.addBlockedBy);
  ensureDependenciesExist(state, task.id, [...blocks, ...blockedBy]);

  for (const blockedId of blocks) {
    const blocked = findTask(state, blockedId);
    if (!blocked.blockedBy.includes(task.id)) {
      if (blocked.status !== "pending") {
        throw new Error(
          `Cannot add a blocker to task #${blocked.id} while it is ${blocked.status}.`,
        );
      }
      task.blocks.push(blockedId);
      blocked.blockedBy.push(task.id);
      blocked.updatedAt = now;
    }
  }
  if (blocks.length > 0) updatedFields.push("blocks");

  for (const blockerId of blockedBy) {
    const blocker = findTask(state, blockerId);
    if (!task.blockedBy.includes(blockerId)) {
      if (task.status !== "pending") {
        throw new Error(
          `Cannot add a blocker to task #${task.id} while it is ${task.status}.`,
        );
      }
      task.blockedBy.push(blockerId);
      blocker.blocks.push(task.id);
      blocker.updatedAt = now;
    }
  }
  if (blockedBy.length > 0) updatedFields.push("blockedBy");

  ensureAcyclic(state);

  if (input.status !== undefined && input.status !== task.status) {
    ensureStatusTransition(task.status, input.status);
    if (input.status === "in_progress") {
      const blockers = incompleteBlockers(state, task);
      if (blockers.length > 0) {
        throw new Error(
          `Task #${task.id} is blocked by ${blockers.map((blocker) => `#${blocker.id}`).join(", ")}.`,
        );
      }
    }
    task.status = input.status;
    if (input.status === "completed") task.completedAt = now;
    else delete task.completedAt;
    updatedFields.push("status");
  }

  if (updatedFields.length === 0) {
    throw new Error("TaskUpdate requires at least one field to update.");
  }

  task.updatedAt = now;
  ensureStateSize(state);
  return { state, task: cloneTask(task), updatedFields };
}

export function updateTasks(
  current: TaskState,
  inputs: readonly UpdateTaskInput[],
  now = new Date().toISOString(),
): {
  state: TaskState;
  updates: Array<{
    task: TaskRecord;
    previousStatus: TaskStatus;
    updatedFields: string[];
  }>;
} {
  requireBatchSize("TaskUpdate", inputs.length);

  let state = current;
  const updates: Array<{
    task: TaskRecord;
    previousStatus: TaskStatus;
    updatedFields: string[];
  }> = [];
  for (const [index, input] of inputs.entries()) {
    try {
      const previousStatus = findTask(state, input.taskId).status;
      const updated = updateTask(state, input, now);
      state = updated.state;
      updates.push({
        task: updated.task,
        previousStatus,
        updatedFields: updated.updatedFields,
      });
    } catch (error) {
      throw batchItemError("TaskUpdate", index, error);
    }
  }

  return { state, updates };
}

export function stopTask(
  current: TaskState,
  taskId: string,
  now = new Date().toISOString(),
): { state: TaskState; task: TaskRecord } {
  const state = cloneTaskState(current);
  const task = findTask(state, taskId);
  if (task.status === "completed") {
    throw new Error(`Task #${task.id} is completed and cannot be stopped.`);
  }

  state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
  for (const candidate of state.tasks) {
    const blocks = candidate.blocks.filter((id) => id !== task.id);
    const blockedBy = candidate.blockedBy.filter((id) => id !== task.id);
    if (
      blocks.length !== candidate.blocks.length ||
      blockedBy.length !== candidate.blockedBy.length
    ) {
      candidate.updatedAt = now;
    }
    candidate.blocks = blocks;
    candidate.blockedBy = blockedBy;
  }
  ensureStateSize(state);
  return { state, task: cloneTask(task) };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isTaskComment(value: unknown): value is TaskComment {
  return (
    isRecord(value) &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string"
  );
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    /^\d+$/.test(value.id) &&
    typeof value.subject === "string" &&
    typeof value.description === "string" &&
    typeof value.activeForm === "string" &&
    isTaskStatus(value.status) &&
    (value.owner === undefined || typeof value.owner === "string") &&
    isStringArray(value.blocks) &&
    isStringArray(value.blockedBy) &&
    Array.isArray(value.comments) &&
    value.comments.every(isTaskComment) &&
    isRecord(value.metadata) &&
    isJsonValue(value.metadata) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.completedAt === undefined || typeof value.completedAt === "string")
  );
}

export function isTaskState(value: unknown): value is TaskState {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return false;
  if (
    !Number.isInteger(value.nextId) ||
    typeof value.nextId !== "number" ||
    value.nextId < 1 ||
    value.tasks.length > MAX_TASKS ||
    !value.tasks.every(isTaskRecord)
  ) {
    return false;
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_TASK_STATE_BYTES) {
    return false;
  }

  const ids = new Set(value.tasks.map((task) => task.id));
  const maxId = value.tasks.reduce(
    (maximum, task) => Math.max(maximum, Number(task.id)),
    0,
  );
  if (ids.size !== value.tasks.length || value.nextId <= maxId) return false;

  const tasksById = new Map(value.tasks.map((task) => [task.id, task]));
  const consistent = value.tasks.every(
    (task) =>
      task.blocks.every(
        (id) =>
          ids.has(id) &&
          tasksById.get(id)?.blockedBy.includes(task.id) === true,
      ) &&
      task.blockedBy.every(
        (id) =>
          ids.has(id) && tasksById.get(id)?.blocks.includes(task.id) === true,
      ),
  );
  if (!consistent) return false;

  try {
    ensureAcyclic({ tasks: value.tasks, nextId: value.nextId });
    return true;
  } catch {
    return false;
  }
}

export function isTaskStateDetails(value: unknown): value is TaskStateDetails {
  return (
    isRecord(value) &&
    value.version === 2 &&
    (value.action === "create" ||
      value.action === "list" ||
      value.action === "get" ||
      value.action === "update" ||
      value.action === "stop") &&
    isTaskState(value.state) &&
    (value.taskId === undefined || typeof value.taskId === "string") &&
    (value.taskIds === undefined || isStringArray(value.taskIds))
  );
}

export function restoreTaskStateFromBranch(
  entries: readonly unknown[],
): TaskState {
  let restored = emptyTaskState();

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    if (
      message.role !== "toolResult" ||
      typeof message.toolName !== "string" ||
      !TASK_TOOL_NAMES.has(message.toolName) ||
      !isTaskStateDetails(message.details)
    ) {
      continue;
    }
    restored = cloneTaskState(message.details.state);
  }

  return restored;
}

export function completedTaskCount(state: TaskState): number {
  return state.tasks.filter((task) => task.status === "completed").length;
}

export function readyTasks(state: TaskState): TaskRecord[] {
  return state.tasks
    .filter(
      (task) =>
        task.status === "pending" &&
        incompleteBlockers(state, task).length === 0,
    )
    .map(cloneTask);
}

export function formatTaskList(state: TaskState): string {
  if (state.tasks.length === 0) return "No tasks.";

  const completed = completedTaskCount(state);
  const lines = state.tasks.map((task) => {
    const owner = task.owner ? ` owner=${task.owner}` : "";
    const blockedBy =
      task.blockedBy.length > 0
        ? ` blockedBy=${task.blockedBy.map((id) => `#${id}`).join(",")}`
        : "";
    return `#${task.id} [${task.status}] ${task.subject}${owner}${blockedBy}`;
  });
  return `Tasks (${completed}/${state.tasks.length} completed):\n${lines.join("\n")}`;
}

export function formatTaskDetails(task: TaskRecord): string {
  const lines = [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
    `Active form: ${task.activeForm}`,
    `Owner: ${task.owner ?? "unassigned"}`,
    `Blocks: ${task.blocks.length ? task.blocks.map((id) => `#${id}`).join(", ") : "none"}`,
    `Blocked by: ${task.blockedBy.length ? task.blockedBy.map((id) => `#${id}`).join(", ") : "none"}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
  ];
  if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);
  if (Object.keys(task.metadata).length > 0) {
    lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
  }
  if (task.comments.length > 0) {
    lines.push(
      "Comments:",
      ...task.comments.map(
        (comment) => `- ${comment.createdAt}: ${comment.content}`,
      ),
    );
  }
  return lines.join("\n");
}
