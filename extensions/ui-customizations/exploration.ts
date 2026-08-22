import type { ToolCall } from "@earendil-works/pi-ai";
import {
  ToolExecutionComponent,
  type MessageUpdateEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  hyperlink,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { glyphs, type ThemeText } from "../shared/ui-kit.ts";

export type ExplorationToolName = "read" | "fffind" | "ffgrep";
export type ExplorationToolKind = "read" | "search";

/** The two tool arguments an exploration row shows. */
const explorationToolArgsFields = z.object({
  path: z.string().optional().catch(undefined),
  pattern: z.string().optional().catch(undefined),
});

/**
 * A streaming tool call reports its arguments as an object once the provider has
 * finished them and as a (possibly truncated) JSON string until then.
 */
const explorationToolArgsText = z.string().transform((text) => {
  try {
    return explorationToolArgsFields.parse(JSON.parse(text));
  } catch {
    return {};
  }
});

/** Decodes whatever a tool call reports as its arguments; never throws. */
export const explorationToolArgsSchema = z
  .union([explorationToolArgsFields, explorationToolArgsText])
  .catch({});

export type ExplorationToolArgs = z.infer<typeof explorationToolArgsSchema>;

/** The only tool-result field an exploration row reads: ffgrep's match count. */
export const explorationToolResultSchema = z
  .object({
    details: z
      .object({ totalMatched: z.number().optional().catch(undefined) })
      .optional()
      .catch(undefined),
  })
  .catch({});

export type ExplorationToolResult = z.infer<typeof explorationToolResultSchema>;

/** Sessions written by older builds persist the tool error flag as `"true"`. */
const toolResultErrorSchema = z
  .union([z.boolean(), z.literal("true").transform(() => true)])
  .catch(false);

export interface ExplorationItem {
  toolCallId: string;
  toolName: ExplorationToolName;
  args: ExplorationToolArgs;
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
    return `  → Read ${args.path ?? "?"}`;
  }

  const query = args.pattern ?? "";
  const path = args.path ?? ".";
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
      item.status === "completed"
        ? styles.muted
        : item.status === "error"
          ? styles.error
          : styles.active;
    const errorSuffix = item.status === "error" ? " (error)" : "";
    lines.push(itemStyle(truncated(`${itemToolline(item)}${errorSuffix}`, width)));
  }

  return lines;
}

/** The message and stream event `message_update` hands to the tracker. */
type StreamedMessage = MessageUpdateEvent["message"];
type AssistantStreamEvent = MessageUpdateEvent["assistantMessageEvent"];

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
    args: ExplorationToolArgs,
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

  private finalizeToolResult(
    toolCallId: string,
    status: "completed" | "error",
    matchCount?: number,
  ): void {
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

  private classifyToolName(name: string): ExplorationToolName | undefined {
    if (name === "read" || name === "fffind" || name === "ffgrep") return name;
    return undefined;
  }

  private processToolCall(call: ToolCall, isNew: boolean): void {
    if (!call.name) return;

    const name = this.classifyToolName(call.name);
    if (!name) {
      if (isNew) this.sealGroup();
      return;
    }

    if (!call.id) return;
    const args = explorationToolArgsSchema.parse(call.arguments);
    const item = this.toolIdToItem.get(call.id);
    if (item) {
      item.args = args;
      return;
    }
    this.setExplorationItem(call.id, name, args, "pending");
  }

  restore(entries: readonly SessionEntry[]): void {
    this.reset();

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.message;

      if (message.role === "assistant") {
        const seenInThisMessage: string[] = [];
        this.seenByMessage.clear();
        const content = message.content;
        for (let i = 0; i < content.length; i += 1) {
          const item = content[i];
          if (item === undefined) continue;
          if (item.type === "text" || item.type === "thinking") {
            this.sealGroup();
            continue;
          }

          if (item.type === "toolCall") {
            if (!item.name) continue;
            const key = item.id ? `id:${item.id}` : `idx:${i}`;
            const isNew = !this.seenByMessage.has(key);
            if (isNew) this.seenByMessage.add(key);
            if (item.id) seenInThisMessage.push(item.id);
            this.processToolCall(item, isNew);
          }
        }

        if (message.stopReason === "error" || message.stopReason === "aborted") {
          this.markUnresolvedToolError(seenInThisMessage);
        }
        continue;
      }

      if (message.role === "user") {
        this.sealGroup();
        continue;
      }

      if (message.role === "toolResult") {
        if (!message.toolCallId) continue;
        const toolName = this.classifyToolName(message.toolName);
        const isError = toolResultErrorSchema.parse(message.isError);
        let matchCount: number | undefined;
        if (toolName === "ffgrep") {
          matchCount = explorationToolResultSchema.parse(message).details?.totalMatched;
        }
        this.finalizeToolResult(message.toolCallId, isError ? "error" : "completed", matchCount);
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

  handleMessageUpdate(message: StreamedMessage, streamEvent: AssistantStreamEvent): void {
    if (message.role !== "assistant") return;
    if (streamEvent.type === "start") this.seenByMessage.clear();

    const content = message.content;
    for (let i = 0; i < content.length; i += 1) {
      const entry = content[i];
      if (entry === undefined) continue;
      if (entry.type === "text" || entry.type === "thinking") {
        const key = `block:${i}:${entry.type}`;
        if (!this.seenByMessage.has(key)) {
          this.seenByMessage.add(key);
          this.sealGroup();
        }
        continue;
      }
      if (entry.type === "toolCall") {
        if (!entry.name) continue;
        const key = entry.id ? `id:${entry.id}` : `idx:${i}`;
        const alreadySeen = this.seenByMessage.has(key);
        if (!alreadySeen) this.seenByMessage.add(key);
        this.processToolCall(entry, !alreadySeen);
      }
    }
  }

  toolExecutionStart(id: string, name: string, args: ExplorationToolArgs): void {
    const toolName = this.classifyToolName(name);
    if (!toolName) return;
    this.setExplorationItem(id, toolName, args, "running");
  }

  toolExecutionUpdate(id: string, name: string, args: ExplorationToolArgs): void {
    const toolName = this.classifyToolName(name);
    if (!toolName) return;
    const item = this.toolIdToItem.get(id);
    if (item) {
      item.status =
        item.status === "completed" ? "completed" : item.status === "error" ? "error" : "running";
      item.args = args;
      item.toolName = toolName;
    } else {
      this.setExplorationItem(id, toolName, args, "running");
    }
  }

  toolExecutionEnd(
    id: string,
    name: string,
    result: ExplorationToolResult,
    isError: boolean,
  ): void {
    const toolName = this.classifyToolName(name);
    if (!toolName) return;
    const matchCount = toolName === "ffgrep" ? result.details?.totalMatched : undefined;
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
  theme?: ThemeText;
  getActiveSpinner?: () => string;
};

/** How a tool row renders itself before the patch wraps it. */
type ToolRowRender = (this: ToolExecutionComponent, width: number) => string[];

/**
 * The two prototype slots this patch owns: its state, parked under a globally
 * registered symbol so a reloaded module reuses it, and the render entry point
 * it replaces. Declaring `render` as a plain function property also keeps the
 * captured original an ordinary value rather than an unbound method reference.
 */
type ToolRowPrototype = {
  [RENDER_STATE_KEY]?: RenderState;
  render: ToolRowRender;
};

/** The row fields the patch reads; the SDK keeps all of them private. */
const toolRowSchema = z
  .object({
    toolCallId: z.string().optional().catch(undefined),
    toolName: z.string().optional().catch(undefined),
    isPartial: z.boolean().optional().catch(undefined),
    result: z
      .object({ isError: z.boolean().optional().catch(undefined) })
      .optional()
      .catch(undefined),
  })
  .catch({});

function toolRowPrototype(): ToolExecutionComponent & ToolRowPrototype {
  // SAFETY: the patch stores its state and its replacement render on the
  // prototype itself, so the only widening is the two slots it writes there;
  // every row field it reads is decoded from the live instance instead.
  return ToolExecutionComponent.prototype as ToolExecutionComponent & ToolRowPrototype;
}

type ToolExecutionRuntime = z.infer<typeof toolRowSchema>;

function firstContentLine(lines: readonly string[]): number {
  return lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
}

function decorateStatusLine(line: string, width: number, status: string): string {
  if (width <= 0) return "";

  const plainLine = stripTerminalSequences(line);
  const firstContentIndex = plainLine.search(/\S/);
  if (firstContentIndex === -1) return line;

  const originalIndentWidth = visibleWidth(plainLine.slice(0, firstContentIndex));
  const statusWidth = visibleWidth(status);
  const indentWidth = Math.min(originalIndentWidth, Math.max(0, width - statusWidth));
  const separator = width - indentWidth > statusWidth ? " " : "";
  const contentWidth = Math.max(0, width - indentWidth - statusWidth - visibleWidth(separator));
  const indent = sliceByColumn(line, 0, indentWidth);
  const content = sliceByColumn(line, originalIndentWidth, contentWidth);

  return truncateToWidth(`${indent}${status}${separator}${content}`, width, "");
}

function statusGlyphFor(row: ToolExecutionRuntime, theme: ThemeText, spinner: string): string {
  if (row.isPartial === true) return theme.fg("accent", spinner);
  if (row.result?.isError === true) return theme.fg("error", glyphs.error);
  return theme.fg("success", glyphs.success);
}

export function installExplorationRenderer(
  tracker: ExplorationTracker,
  theme: ThemeText,
  getActiveSpinner: () => string = () => "⠋",
): void {
  const proto = toolRowPrototype();
  const state = proto[RENDER_STATE_KEY] ?? { patched: false };
  if (!state.patched) {
    const originalRender = proto.render;
    state.patched = true;
    proto.render = function renderWithExploration(width: number): string[] {
      const row = toolRowSchema.parse(this);
      const currentState = proto[RENDER_STATE_KEY];
      const currentTracker = currentState?.tracker;
      if (!row.toolCallId || !currentTracker) {
        return originalRender.call(this, width);
      }
      if (row.toolName === "subagent_spawn") {
        return originalRender.call(this, width);
      }

      const activeGroup = currentTracker.groupForTool(row.toolCallId);
      if (!activeGroup) {
        const currentTheme = currentState.theme;
        if (!currentTheme) return originalRender.call(this, width);

        const lines = originalRender.call(this, width);
        const contentLineIndex = firstContentLine(lines);
        if (contentLineIndex === -1) return lines;

        const status = statusGlyphFor(row, currentTheme, currentState.getActiveSpinner?.() ?? "⠋");
        const decorated = [...lines];
        decorated[contentLineIndex] = decorateStatusLine(lines[contentLineIndex]!, width, status);
        return decorated;
      }
      if (!currentTracker.isLeader(row.toolCallId)) return [];

      const currentTheme = currentState.theme;
      if (!currentTheme) return originalRender.call(this, width);
      const styles: ExplorationStyles = {
        active: (text) => currentTheme.fg("accent", text),
        muted: (text) => currentTheme.fg("muted", text),
        error: (text) => currentTheme.fg("error", text),
      };
      return [
        "",
        ...renderExplorationGroup(
          activeGroup,
          width,
          styles,
          currentState.getActiveSpinner?.() ?? "⠋",
        ),
      ];
    };
    proto[RENDER_STATE_KEY] = state;
  }

  state.tracker = tracker;
  state.theme = theme;
  state.getActiveSpinner = getActiveSpinner;
  proto[RENDER_STATE_KEY] = state;
}

export function clearExplorationRenderer(tracker: ExplorationTracker): void {
  const proto = toolRowPrototype();
  const state = proto[RENDER_STATE_KEY];
  if (state && state.tracker === tracker) {
    state.tracker = undefined;
    state.theme = undefined;
    state.getActiveSpinner = undefined;
    proto[RENDER_STATE_KEY] = state;
  }
}

const CLICK_STATE_KEY = Symbol.for("pi.ui-customizations.exploration.click");

/** The fullscreen TUI's OSC 8 click hook. */
type UrlOpener = (url: string) => void;

type ClickState = {
  tracker: ExplorationTracker;
  originalOpenUrl: UrlOpener;
  wrapper: UrlOpener;
};

/**
 * The TUI slots this patch touches: the private click hook it wraps and its own
 * state, again parked under a globally registered symbol.
 */
type ClickPatchTui = {
  [CLICK_STATE_KEY]?: ClickState;
  openUrl?: UrlOpener;
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
  // SAFETY: the fullscreen TUI keeps its OSC 8 hook in a private `openUrl`
  // field that the public interface omits; the intersection only adds that hook
  // and this patch's own symbol slot, both of which it sets itself.
  const runtime = tui as TUI & ClickPatchTui;

  if (runtime.mode !== "fullscreen") {
    return () => {};
  }

  const originalOpenUrl = runtime.openUrl;
  if (originalOpenUrl === undefined) {
    return () => {};
  }

  const wrapper: UrlOpener = (url) => {
    const decodedId = parseExplorationLink(url);
    if (decodedId === undefined) {
      return originalOpenUrl.call(runtime, url);
    }
    if (!tracker.toggle(decodedId)) {
      return originalOpenUrl.call(runtime, url);
    }
    runtime.requestRender();
    return undefined;
  };
  runtime[CLICK_STATE_KEY] = { tracker, originalOpenUrl, wrapper };
  runtime.openUrl = wrapper;

  return () => {
    const current = runtime[CLICK_STATE_KEY];
    if (!current) return;
    if (current.wrapper !== runtime.openUrl || current.tracker !== tracker) return;
    runtime.openUrl = current.originalOpenUrl;
    delete runtime[CLICK_STATE_KEY];
  };
}
