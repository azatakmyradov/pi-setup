import { ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

export type ExplorationToolName = "read" | "fffind" | "ffgrep";
export type ExplorationToolKind = "read" | "search";

export interface ExplorationItem {
  toolCallId: string;
  toolName: ExplorationToolName;
  args: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "error";
  matchCount?: number;
}

export interface ExplorationGroup {
  id: string;
  items: ExplorationItem[];
  active: boolean;
  expanded: boolean;
}

export function classifyExplorationTool(name: string): ExplorationToolKind | undefined {
  if (name === "read") return "read";
  if (name === "fffind" || name === "ffgrep") return "search";
  return undefined;
}

export interface ExplorationStyles {
  active: (text: string) => string;
  muted: (text: string) => string;
  error: (text: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatExplorationCounts(items: readonly ExplorationItem[]): string {
  let reads = 0;
  let searches = 0;
  for (const item of items) {
    if (item.toolName === "read") reads += 1;
    else searches += 1;
  }

  const chunks: string[] = [];
  if (reads > 0) chunks.push(`${reads} read${reads === 1 ? "" : "s"}`);
  if (searches > 0) chunks.push(`${searches} search${searches === 1 ? "" : "es"}`);
  return chunks.join(", ");
}

function truncated(text: string, width: number): string {
  return truncateToWidth(text, width);
}

function itemToolline(item: ExplorationItem): string {
  const args = item.args;
  if (item.toolName === "read") {
    return `  → Read ${asString(args.path) ?? "?"}`;
  }

  const query = asString(args.pattern) ?? "";
  const path = asString(args.path) ?? ".";
  const label = item.toolName === "fffind" ? "Find" : "Grep";
  if (item.toolName === "ffgrep" && item.matchCount !== undefined) {
    return `  * ${label} "${query}" in ${path} (${item.matchCount} match${item.matchCount === 1 ? "" : "es"})`;
  }
  return `  * ${label} "${query}" in ${path}`;
}

export function renderExplorationGroup(
  group: ExplorationGroup,
  width: number,
  styles: ExplorationStyles,
  activeSpinner = "⠋",
): string[] {
  const icon = group.active ? activeSpinner : group.expanded ? "⌄" : "›";
  const statusWord = group.active ? "Exploring" : "Explored";
  const counts = formatExplorationCounts(group.items);
  const title = counts.length > 0 ? `${statusWord} — ${counts}` : statusWord;
  const hasError = group.items.some((item) => item.status === "error");
  const style = group.active ? styles.active : hasError ? styles.error : styles.muted;
  const link = `pi-exploration://group/${encodeURIComponent(group.id)}`;
  const header = style(truncated(`${icon} ${title}`, width));
  const lines: string[] = [hyperlink(header, link)];

  if (!group.expanded) return lines;

  for (const item of group.items) {
    const itemStyle =
      item.status === "completed" ? styles.muted : item.status === "error" ? styles.error : styles.active;
    const errorSuffix = item.status === "error" ? " (error)" : "";
    lines.push(itemStyle(truncated(`${itemToolline(item)}${errorSuffix}`, width)));
  }

  return lines;
}

type AssistantContentEntry = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

type AssistantMessage = {
  role: "assistant";
  content?: unknown;
  stopReason?: unknown;
};

type ToolResultMessage = {
  role: "toolResult";
  toolCallId?: unknown;
  toolName?: unknown;
  details?: unknown;
  isError?: unknown;
};

type SessionEntry = { type?: unknown; message?: unknown };

type RuntimeEvent = { type?: unknown };

function getContentEntries(message: AssistantMessage): AssistantContentEntry[] {
  if (!Array.isArray(message.content)) return [];
  const filtered: AssistantContentEntry[] = [];
  for (const content of message.content) {
    if (isRecord(content)) filtered.push(content as AssistantContentEntry);
  }
  return filtered;
}

function parseStopReason(message: AssistantMessage): string | undefined {
  return asString(message.stopReason);
}

function parseToolCallArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return {};
}

export class ExplorationTracker {
  private groups: ExplorationGroup[] = [];
  private toolIdToGroup = new Map<string, ExplorationGroup>();
  private toolIdToItem = new Map<string, ExplorationItem>();
  private activeGroupId: string | undefined;
  private seenByMessage = new Set<string>();
  private groupCounter = 0;

  reset(): void {
    this.groups = [];
    this.toolIdToGroup.clear();
    this.toolIdToItem.clear();
    this.activeGroupId = undefined;
    this.seenByMessage.clear();
    this.groupCounter = 0;
  }

  clear(): void {
    this.reset();
  }

  private createGroup(): ExplorationGroup {
    const group: ExplorationGroup = {
      id: `group-${this.groupCounter++}`,
      items: [],
      active: true,
      expanded: false,
    };
    this.groups.push(group);
    this.activeGroupId = group.id;
    return group;
  }

  private currentGroup(): ExplorationGroup | undefined {
    if (this.activeGroupId === undefined) return undefined;
    return this.groups.find((group) => group.id === this.activeGroupId);
  }

  private sealGroup(): void {
    const group = this.currentGroup();
    if (group) group.active = false;
    this.activeGroupId = undefined;
  }

  private ensureGroupForTool(): ExplorationGroup {
    const current = this.currentGroup();
    if (current && current.active) {
      return current;
    }
    const group = this.createGroup();
    return group;
  }

  private setExplorationItem(
    toolCallId: string,
    toolName: ExplorationToolName,
    args: Record<string, unknown>,
    status: ExplorationItem["status"],
  ): ExplorationItem {
    const existingGroup = this.toolIdToGroup.get(toolCallId);
    const existingItem = this.toolIdToItem.get(toolCallId);
    if (existingItem && existingGroup) {
      existingItem.toolName = toolName;
      existingItem.args = args;
      if (existingItem.status !== "completed" && existingItem.status !== "error") {
        existingItem.status = status;
      }
      return existingItem;
    }

    const group = this.ensureGroupForTool();
    const item: ExplorationItem = {
      toolCallId,
      toolName,
      args,
      status,
    };
    group.items.push(item);
    this.toolIdToGroup.set(toolCallId, group);
    this.toolIdToItem.set(toolCallId, item);
    return item;
  }

  private finalizeToolResult(toolCallId: string, status: "completed" | "error", matchCount?: number): void {
    const item = this.toolIdToItem.get(toolCallId);
    if (!item) return;
    item.status = status;
    if (matchCount !== undefined) item.matchCount = matchCount;
  }

  private markUnresolvedToolError(toolCallIds: readonly string[]): void {
    for (const toolCallId of toolCallIds) {
      const item = this.toolIdToItem.get(toolCallId);
      if (item && item.status !== "completed" && item.status !== "error") {
        item.status = "error";
      }
    }
  }

  private classifyToolName(rawName: unknown): ExplorationToolName | undefined {
    const name = asString(rawName);
    if (name === "read" || name === "fffind" || name === "ffgrep") return name;
    return undefined;
  }

  private processToolCall(entry: AssistantContentEntry, isNew: boolean): void {
    const rawName = asString(entry.name);
    if (!rawName) return;

    const name = this.classifyToolName(rawName);
    if (!name) {
      if (isNew) this.sealGroup();
      return;
    }

    const id = asString(entry.id);
    if (!id) return;
    const args = parseToolCallArgs(entry.arguments);
    const item = this.toolIdToItem.get(id);
    if (item) {
      item.args = args;
      return;
    }
    this.setExplorationItem(id, name, args, "pending");
  }

  restore(entries: readonly unknown[]): void {
    this.reset();

    for (const rawEntry of entries) {
      if (!isRecord(rawEntry)) continue;
      const entry = rawEntry as SessionEntry;
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!isRecord(message)) continue;

      const role = asString(message.role);
      if (role === "assistant") {
        const assistant = message as AssistantMessage;
        const seenInThisMessage: string[] = [];
        this.seenByMessage.clear();
        const content = getContentEntries(assistant);
        for (let i = 0; i < content.length; i += 1) {
          const item = content[i];
          const type = asString(item?.type);
          if (type === "text" || type === "thinking") {
            this.sealGroup();
            continue;
          }

          if (type === "toolCall") {
            const name = asString(item?.name);
            if (!name) continue;
            const id = asString(item?.id);
            const key = id ? `id:${id}` : `idx:${i}`;
            const isNew = !this.seenByMessage.has(key);
            if (isNew) this.seenByMessage.add(key);
            if (id) seenInThisMessage.push(id);
            this.processToolCall(item, isNew);
          }
        }

        const stopReason = parseStopReason(assistant);
        if (stopReason === "error" || stopReason === "aborted") {
          this.markUnresolvedToolError(seenInThisMessage);
        }
        continue;
      }

      if (role === "user") {
        this.sealGroup();
        continue;
      }

      if (role === "toolResult") {
        const result = message as ToolResultMessage;
        const toolCallId = asString(result.toolCallId);
        if (!toolCallId) continue;
        const toolName = this.classifyToolName(result.toolName);
        const isError = result.isError === true || result.isError === "true";
        let matchCount: number | undefined;
        if (toolName === "ffgrep") {
          const details = asRecord(result.details);
          matchCount = asNumber((details as { totalMatched?: unknown }).totalMatched);
        }
        this.finalizeToolResult(toolCallId, isError ? "error" : "completed", matchCount);
      }
    }

    for (const group of this.groups) {
      group.active = false;
      group.expanded = false;
      for (const item of group.items) {
        if (item.status === "pending" || item.status === "running") {
          item.status = "completed";
        }
      }
    }
    this.activeGroupId = undefined;
  }

  handleMessageUpdate(message: unknown, assistantEvent: unknown): void {
    if (!isRecord(message) || asString(message.role) !== "assistant") return;
    const assistant = message as AssistantMessage;
    const event = isRecord(assistantEvent) ? (assistantEvent as RuntimeEvent) : undefined;
    if (event && asString(event.type) === "start") this.seenByMessage.clear();

    const content = getContentEntries(assistant);
    for (let i = 0; i < content.length; i += 1) {
      const entry = content[i];
      if (!isRecord(entry)) continue;
      const type = asString(entry.type);
      if (type === "text" || type === "thinking") {
        const key = `block:${i}:${type}`;
        if (!this.seenByMessage.has(key)) {
          this.seenByMessage.add(key);
          this.sealGroup();
        }
        continue;
      }
      if (type === "toolCall") {
        const name = asString(entry.name);
        if (!name) continue;
        const id = asString(entry.id);
        const key = id ? `id:${id}` : `idx:${i}`;
        const alreadySeen = this.seenByMessage.has(key);
        if (!alreadySeen) this.seenByMessage.add(key);
        this.processToolCall(entry, !alreadySeen);
      }
    }
  }

  toolExecutionStart(id: string, name: string, args: Record<string, unknown>): void {
    const toolName = this.classifyToolName(name);
    if (!toolName) return;
    this.setExplorationItem(id, toolName, asRecord(args), "running");
  }

  toolExecutionUpdate(id: string, name: string, args: Record<string, unknown>): void {
    const toolName = this.classifyToolName(name);
    if (!toolName) return;
    const item = this.toolIdToItem.get(id);
    if (item) {
      item.status = item.status === "completed" ? "completed" : item.status === "error" ? "error" : "running";
      item.args = asRecord(args);
      item.toolName = toolName;
    } else {
      this.setExplorationItem(id, toolName, asRecord(args), "running");
    }
  }

  toolExecutionEnd(id: string, name: string, result: unknown, isError: boolean): void {
    const toolName = this.classifyToolName(name);
    if (!toolName) return;
    const matchCount =
      toolName === "ffgrep" ? asNumber((asRecord(asRecord(result).details) as { totalMatched?: unknown }).totalMatched) : undefined;
    this.finalizeToolResult(id, isError ? "error" : "completed", matchCount);
  }

  settle(): void {
    const activeGroup = this.currentGroup();
    if (activeGroup) {
      activeGroup.active = false;
    }
    this.activeGroupId = undefined;
  }

  toggle(groupId: string): boolean {
    for (const group of this.groups) {
      if (group.id === groupId) {
        group.expanded = !group.expanded;
        return true;
      }
    }
    return false;
  }

  groupForTool(toolCallId: string): ExplorationGroup | undefined {
    return this.toolIdToGroup.get(toolCallId);
  }

  isLeader(toolCallId: string): boolean {
    const group = this.toolIdToGroup.get(toolCallId);
    if (!group || group.items.length === 0) return false;
    return group.items[0]?.toolCallId === toolCallId;
  }
}

const RENDER_STATE_KEY = Symbol.for("pi.ui-customizations.exploration.render");
type RenderState = {
  patched: boolean;
  tracker?: ExplorationTracker;
  theme?: Theme;
};

export function installExplorationRenderer(
  tracker: ExplorationTracker,
  theme: Theme,
  getActiveSpinner: () => string = () => "⠋",
): void {
  const proto = ToolExecutionComponent.prototype as unknown as Record<string | symbol, unknown>;
  const state = (proto[RENDER_STATE_KEY] ?? {}) as RenderState;
  if (!state.patched) {
    const originalRender = proto.render as (this: unknown, width: number) => string[];
    state.patched = true;
    proto.render = function renderWithExploration(this: unknown, width: number): string[] {
      const runtime = this as { toolCallId?: unknown };
      const toolCallId = asString(runtime.toolCallId);
      const currentState = proto[RENDER_STATE_KEY] as RenderState | undefined;
      const currentTracker = currentState?.tracker;
      if (!toolCallId || !currentTracker) {
        return originalRender.call(this, width);
      }
      const activeGroup = currentTracker.groupForTool(toolCallId);
      if (!activeGroup) return originalRender.call(this, width);
      if (!currentTracker.isLeader(toolCallId)) return [];

      const currentTheme = currentState.theme;
      if (!currentTheme) return originalRender.call(this, width);
      const styles: ExplorationStyles = {
        active: (text) => currentTheme.fg("accent", text),
        muted: (text) => currentTheme.fg("muted", text),
        error: (text) => currentTheme.fg("error", text),
      };
      return [
        "",
        ...renderExplorationGroup(activeGroup, width, styles, getActiveSpinner()),
      ];
    };
    proto[RENDER_STATE_KEY] = state;
  }

  state.tracker = tracker;
  state.theme = theme;
  proto[RENDER_STATE_KEY] = state;
}

export function clearExplorationRenderer(tracker: ExplorationTracker): void {
  const proto = ToolExecutionComponent.prototype as unknown as Record<string | symbol, unknown>;
  const state = proto[RENDER_STATE_KEY] as RenderState | undefined;
  if (state && state.tracker === tracker) {
    state.tracker = undefined;
    state.theme = undefined;
    proto[RENDER_STATE_KEY] = state;
  }
}

const CLICK_STATE_KEY = Symbol.for("pi.ui-customizations.exploration.click");
type UrlHandler = (...args: unknown[]) => unknown;

type ClickState = {
  tracker: ExplorationTracker;
  originalOpenUrl: UrlHandler;
  wrapper: UrlHandler;
};

function parseExplorationLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "pi-exploration:") return undefined;
    if (parsed.search || parsed.hash) return undefined;
    if (parsed.host !== "group") return undefined;
    const raw = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
    if (raw.length === 0 || raw.includes("/")) return undefined;
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export function installExplorationClickHandler(tui: TUI, tracker: ExplorationTracker): () => void {
  const tuiRuntime = tui as unknown as Record<string | symbol, unknown> & {
    mode?: unknown;
    openUrl?: unknown;
    requestRender?: unknown;
  };

  const mode = asString(tuiRuntime.mode);
  if (mode !== "fullscreen") {
    return () => {};
  }

  const openUrl = tuiRuntime.openUrl;
  if (typeof openUrl !== "function") {
    return () => {};
  }

  const originalOpenUrl = openUrl as UrlHandler;
  const wrapper = (...args: unknown[]): unknown => {
    const firstArg = args[0];
    if (typeof firstArg !== "string") {
      return Reflect.apply(originalOpenUrl, tuiRuntime, args);
    }
    const decodedId = parseExplorationLink(firstArg);
    if (decodedId === undefined) {
      return Reflect.apply(originalOpenUrl, tuiRuntime, args);
    }
    const toggled = tracker.toggle(decodedId);
    if (!toggled) {
      return Reflect.apply(originalOpenUrl, tuiRuntime, args);
    }
    const requestRender = tuiRuntime.requestRender;
    if (typeof requestRender === "function") Reflect.apply(requestRender, tuiRuntime, []);
    return undefined;
  };
  tuiRuntime[CLICK_STATE_KEY] = { tracker, originalOpenUrl, wrapper };
  tuiRuntime.openUrl = wrapper;

  return () => {
    const current = tuiRuntime[CLICK_STATE_KEY] as ClickState | undefined;
    if (!current) return;
    if (current.wrapper !== tuiRuntime.openUrl || current.tracker !== tracker) return;
    if (current.originalOpenUrl !== undefined) tuiRuntime.openUrl = current.originalOpenUrl;
    delete tuiRuntime[CLICK_STATE_KEY];
  };
}
