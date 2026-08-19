import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  convertToPng,
  createBashToolDefinition,
  CustomEditor,
  formatDimensionNote,
  keyText,
  resizeImage,
  UserMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
  type InputEventResult,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  collectThoughtRuns,
  formatDuration,
  renderThought,
  runDuration,
  streamingThoughtTitle,
  type ThoughtRun,
} from "./thinking.ts";

export { formatDuration } from "./thinking.ts";

const TURN_META_ENTRY = "opencode-turn-meta";
const CURSOR_RESET = "\x1b[0m";
const REVERSE_OFF = "\x1b[27m";
const WORKING_SPINNER_INTERVAL_MS = 60;
const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 2_000;
const MESSAGE_PADDING_X = 2;
const USER_MESSAGE_BORDER_PATCH = Symbol.for(
  "pi-setup:ui-customizations:user-message-border",
);
const USER_MESSAGE_BORDER_THEME = Symbol.for(
  "pi-setup:ui-customizations:user-message-border-theme",
);
const THINKING_PATCH = Symbol.for("pi-setup:ui-customizations:thinking");
const THINKING_STATE = Symbol.for("pi-setup:ui-customizations:thinking-state");
const THOUGHT_SENTINEL = "\u0000pi-setup-thought:";
const THOUGHT_SENTINEL_PATTERN = /\u0000pi-setup-thought:(\d+)\u0000/;
const MAX_TRACKED_THOUGHTS = 200;
const TERMINAL_CONTROL_PREFIX =
  /^(?:(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\)))+/;
const ANSI_CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TRAILING_PADDING_SPACE = / (?=(?:\x1b\[[0-?]*[ -/]*[@-~])*$)/;
const IMAGE_PATH_PATTERN =
  /(?:^|[ \t\r\n])(\/(?:\\.|[^ \t\r\n])+?\.(?:png|jpe?g|gif|webp|bmp))(?=[ \t\r\n]|$)/gi;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const LEGACY_ATTACHMENT_MARKER_SENTINEL = "\u200b";
const ATTACHMENT_ID_PREFIX = "\u{e0001}";
const ATTACHMENT_ID_SUFFIX = "\u{e007f}";
const ATTACHMENT_TAG_BASE = 0xe0000;
const ATTACHMENT_MARKER_PATTERN =
  /\[Image (\d+)\]\u{e0001}([\u{e0020}-\u{e007e}]+)\u{e007f}/gu;
const ATTACHMENT_TRACKING_PATTERN =
  /(?:\[Image (\d+)\]\u{e0001}([\u{e0020}-\u{e007e}]+)\u{e007f})|[\u{e0000}-\u{e007f}]+/gu;
const FILE_TAG_PATTERN = /<file name="([^"]+)">([\s\S]*?)<\/file>/g;
const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
]);

interface ImagePathReference {
  source: string;
  path: string;
}

interface ClipboardAttachment extends ImagePathReference {
  image: ImageContent;
  hint?: string;
}

interface AttachmentStyles {
  badge(text: string): string;
  filename(text: string): string;
}

interface TrackedAttachmentMarker {
  source: string;
  label: number;
  id: string;
}

function encodeAttachmentId(id: string): string {
  return Array.from(id, (character) =>
    String.fromCodePoint(ATTACHMENT_TAG_BASE + character.charCodeAt(0)),
  ).join("");
}

function decodeAttachmentId(encoded: string): string {
  return Array.from(encoded, (character) =>
    String.fromCharCode(character.codePointAt(0)! - ATTACHMENT_TAG_BASE),
  ).join("");
}

function findTrackedAttachmentMarkers(text: string): TrackedAttachmentMarker[] {
  return Array.from(text.matchAll(ATTACHMENT_MARKER_PATTERN), (match) => ({
    source: match[0],
    label: Number(match[1]),
    id: decodeAttachmentId(match[2]!),
  }));
}

function attachmentMarker(index: number, id: string): string {
  return `[Image ${index + 1}]${ATTACHMENT_ID_PREFIX}${encodeAttachmentId(id)}${ATTACHMENT_ID_SUFFIX}`;
}

export function stripAttachmentTracking(text: string): string {
  return text
    .replace(
      ATTACHMENT_TRACKING_PATTERN,
      (_source, label: string | undefined) =>
        label === undefined ? "" : `[Image ${label}]`,
    )
    .replaceAll(LEGACY_ATTACHMENT_MARKER_SENTINEL, "");
}

export class DraftAttachmentRegistry {
  private readonly paths = new Map<string, string>();

  add(path: string): string {
    const id = randomUUID();
    this.paths.set(id, path);
    return id;
  }

  get(id: string): string | undefined {
    return this.paths.get(id);
  }

  delete(id: string): void {
    this.paths.delete(id);
  }

  clear(): void {
    this.paths.clear();
  }

  capture(text: string): {
    text: string;
    references: ImagePathReference[];
  } {
    const references: ImagePathReference[] = [];
    const capturedIds = new Set<string>();
    const capturedPaths = new Set<string>();
    const normalized = text.replace(
      ATTACHMENT_TRACKING_PATTERN,
      (source, label: string | undefined, encodedId: string | undefined) => {
        if (label === undefined || encodedId === undefined) return "";
        const id = decodeAttachmentId(encodedId);
        const path = this.paths.get(id);
        if (!path || capturedIds.has(id) || capturedPaths.has(path)) {
          return `[Image ${label}]`;
        }

        capturedIds.add(id);
        capturedPaths.add(path);
        references.push({ source, path });
        return source;
      },
    );

    for (const id of capturedIds) this.paths.delete(id);

    return {
      text: normalized.replaceAll(LEGACY_ATTACHMENT_MARKER_SENTINEL, ""),
      references,
    };
  }
}

export function findImagePathReferences(text: string): ImagePathReference[] {
  const references = Array.from(text.matchAll(IMAGE_PATH_PATTERN), (match) => {
    const source = match[1]!;
    return { source, path: source.replace(/\\(.)/g, "$1") };
  });
  return references.filter(
    ({ path }, index) =>
      references.findIndex((reference) => reference.path === path) === index,
  );
}

export function findClipboardImagePaths(text: string): string[] {
  return findImagePathReferences(text).map(({ path }) => path);
}

export function formatClipboardAttachmentPrompt(
  text: string,
  attachments: readonly Pick<ClipboardAttachment, "source" | "path" | "hint">[],
): string {
  let prompt = text;
  for (const [index, attachment] of attachments.entries()) {
    prompt = prompt.replaceAll(attachment.source, `[Image ${index + 1}]`);
  }

  prompt = stripAttachmentTracking(prompt)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const files = attachments
    .map(
      (attachment) =>
        `<file name="${attachment.path}">${attachment.hint ?? ""}</file>`,
    )
    .join(" ");

  return `${prompt}${prompt ? "\n\n" : ""}${files}`;
}

function isImageAttachment(path: string, content: string): boolean {
  if (!IMAGE_MIME_TYPES.has(extname(path).toLowerCase())) return false;

  const hints = content.trim();
  return (
    hints.length === 0 ||
    hints.split("\n").every((line) => line.trim().startsWith("[Image"))
  );
}

export function renderAttachmentFiles(
  markdown: string,
  styles: AttachmentStyles,
): string {
  let renderedAttachment = false;
  const rendered = markdown.replace(
    FILE_TAG_PATTERN,
    (tag, path: string, content: string) => {
      if (!isImageAttachment(path, content)) return tag;
      renderedAttachment = true;
      return `${styles.badge(" file ")}${styles.filename(` ${basename(path)} `)}`;
    },
  );

  return renderedAttachment
    ? rendered
        .replace(/\[Image \d+\][ \t]*/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trimStart()
    : rendered;
}

async function loadClipboardAttachment(
  reference: ImagePathReference,
): Promise<ClipboardAttachment | undefined> {
  const { path } = reference;
  let mimeType = IMAGE_MIME_TYPES.get(extname(path).toLowerCase());
  if (!mimeType) return undefined;

  let bytes: Uint8Array = await readFile(path);
  if (mimeType === "image/bmp") {
    const converted = await convertToPng(
      Buffer.from(bytes).toString("base64"),
      mimeType,
    );
    if (!converted) return undefined;
    bytes = Buffer.from(converted.data, "base64");
    mimeType = converted.mimeType;
  }

  const resized = await resizeImage(bytes, mimeType);
  if (!resized) return undefined;

  return {
    ...reference,
    image: { type: "image", data: resized.data, mimeType: resized.mimeType },
    hint: formatDimensionNote(resized),
  };
}

export function createScannerFrames(
  width = 8,
  holdStart = 0,
  holdEnd = 0,
): string[] {
  const forward = Array.from({ length: width }, (_, position) => ({
    position,
    direction: 1,
  }));
  const backward = Array.from({ length: width - 2 }, (_, index) => ({
    position: width - index - 2,
    direction: -1,
  }));
  const frames = [
    ...forward,
    ...Array.from({ length: holdEnd }, () => ({
      position: width - 1,
      direction: 1,
    })),
    ...backward,
    ...Array.from({ length: holdStart }, () => ({
      position: 0,
      direction: -1,
    })),
  ];
  const trail = ["■", "▪", "•"];

  return frames.map(({ position, direction }) =>
    Array.from({ length: width }, (_, index) => {
      const distance = (position - index) * direction;
      return trail[distance] ?? "·";
    }).join(""),
  );
}

const WORKING_SPINNER_FRAMES = createScannerFrames();

interface TurnMeta {
  model: string;
  provider: string;
  durationMs: number;
}

interface PanelStyles {
  border(text: string): string;
  background(text: string): string;
  placeholder(text: string): string;
  attachmentBadge?(text: string): string;
  attachmentFilename?(text: string): string;
}

export class InterruptConfirmation {
  private pending = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly timeoutMs = INTERRUPT_CONFIRMATION_TIMEOUT_MS,
  ) {}

  isPending(): boolean {
    return this.pending;
  }

  request(): boolean {
    if (this.pending) {
      this.clear();
      return true;
    }

    this.pending = true;
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      this.pending = false;
      this.onChange();
    }, this.timeoutMs);
    this.onChange();
    return false;
  }

  clear(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    if (!this.pending) return;

    this.pending = false;
    this.onChange();
  }
}

export function interruptPrompt(confirmationPending: boolean): string {
  return confirmationPending ? "again to interrupt" : "interrupt";
}

const logo = [
  ["██████╗ ", "██╗"],
  ["██╔══██╗", "██║"],
  ["██████╔╝", "██║"],
  ["██╔═══╝ ", "██║"],
  ["██║     ", "██║"],
  ["╚═╝     ", "╚═╝"],
] as const;

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function promptWidth(width: number): number {
  return Math.max(1, width);
}

export function addUserMessageBorder(
  lines: string[],
  border: (text: string) => string,
): string[] {
  return lines.map((line) => {
    if (visibleWidth(line) < 1) return line;

    const prefix = line.match(TERMINAL_CONTROL_PREFIX)?.[0] ?? "";
    const content = line.slice(prefix.length);
    const trimmedContent = content.replace(TRAILING_PADDING_SPACE, "");
    if (trimmedContent === content) return line;

    const blankPaddingRow =
      content.replace(ANSI_CSI_SEQUENCE, "").trim().length === 0;
    return (
      prefix +
      border("│") +
      (blankPaddingRow
        ? trimmedContent.replaceAll(" ", "\u00a0")
        : trimmedContent)
    );
  });
}

function installUserMessageBorder(theme: Theme): void {
  const shared = globalThis as unknown as Record<PropertyKey, unknown>;
  shared[USER_MESSAGE_BORDER_THEME] = theme;

  const prototype = UserMessageComponent.prototype;
  if (USER_MESSAGE_BORDER_PATCH in prototype) return;

  const originalRender = prototype.render;
  prototype.render = function (width: number): string[] {
    const lines = originalRender.call(this, width);
    const currentTheme = shared[USER_MESSAGE_BORDER_THEME] as Theme | undefined;
    if (!currentTheme) return lines;
    return addUserMessageBorder(lines, (text) =>
      currentTheme.fg("accent", text),
    );
  };
  Object.defineProperty(prototype, USER_MESSAGE_BORDER_PATCH, { value: true });
}

interface ThinkingState {
  theme: Theme;
  durations: Map<string, number>;
}

/**
 * Pi renders a thinking run as one component: a static label when collapsed, a
 * Markdown block when expanded. Neither carries the run's headline or how long
 * it took, so the run is rendered here instead. The original updateContent is
 * still what builds the transcript — it is coaxed into emitting a placeholder
 * per run (by forcing the collapsed path and handing out sentinel labels), and
 * those placeholders are swapped for ThoughtComponents afterwards.
 */
class ThoughtComponent {
  constructor(
    private readonly run: ThoughtRun,
    private readonly expanded: boolean,
    private readonly paddingX: number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const shared = globalThis as unknown as Record<PropertyKey, unknown>;
    const state = shared[THINKING_STATE] as ThinkingState | undefined;
    if (!state) return [];

    const { theme } = state;
    return renderThought(this.run, this.expanded, width, this.paddingX, {
      collapsed: (text) => theme.fg("thinkingText", text),
      header: (text) => theme.fg("warning", text),
      body: (text) => theme.fg("muted", text),
      bar: (text) => theme.fg("borderMuted", text),
    });
  }
}

interface ThinkingHost {
  contentContainer: { children: unknown[] };
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  outputPad: number;
  updateContent(...args: unknown[]): void;
}

function installThinkingRenderer(state: ThinkingState): void {
  const shared = globalThis as unknown as Record<PropertyKey, unknown>;
  shared[THINKING_STATE] = state;

  const prototype = AssistantMessageComponent.prototype;
  if (THINKING_PATCH in prototype) return;

  const originalUpdate = prototype.updateContent as unknown as (
    this: ThinkingHost,
    ...args: unknown[]
  ) => void;

  function patchedUpdate(this: ThinkingHost, ...args: unknown[]): void {
    const message = args[0] as { content?: { type: string }[] } | undefined;
    const runs = collectThoughtRuns(message?.content ?? []);
    if (runs.length === 0) {
      originalUpdate.apply(this, args);
      return;
    }

    const expanded = !this.hideThinkingBlock;
    const label = this.hiddenThinkingLabel;
    let cursor = 0;

    Object.defineProperty(this, "hiddenThinkingLabel", {
      configurable: true,
      get: () => `${THOUGHT_SENTINEL}${cursor++} `,
      set: () => {},
    });
    this.hideThinkingBlock = true;
    try {
      originalUpdate.apply(this, args);
    } finally {
      delete (this as unknown as Record<string, unknown>).hiddenThinkingLabel;
      this.hiddenThinkingLabel = label;
      this.hideThinkingBlock = !expanded;
    }

    const { children } = this.contentContainer;
    const durations = (shared[THINKING_STATE] as ThinkingState).durations;
    for (const [index, child] of children.entries()) {
      const text = (child as { text?: unknown }).text;
      if (typeof text !== "string") continue;

      const match = THOUGHT_SENTINEL_PATTERN.exec(text);
      const blocks = match ? runs[Number(match[1])] : undefined;
      if (!blocks) continue;

      children[index] = new ThoughtComponent(
        { blocks, durationMs: runDuration(blocks, durations) },
        expanded,
        this.outputPad,
      );
    }
  }

  (prototype as unknown as ThinkingHost).updateContent =
    patchedUpdate as ThinkingHost["updateContent"];
  Object.defineProperty(prototype, THINKING_PATCH, { value: true });
}

export function alignColumns(
  left: string,
  right: string,
  width: number,
): string {
  if (width <= 0) return "";
  if (!right) return truncateToWidth(left, width, "…");

  const minimumGap = 2;
  const fittedRight = truncateToWidth(
    right,
    Math.max(1, Math.floor(width * 0.7)),
    "…",
  );
  const leftWidth = Math.max(0, width - visibleWidth(fittedRight) - minimumGap);
  if (leftWidth === 0) return truncateToWidth(fittedRight, width, "…");

  const fittedLeft = truncateToWidth(left, leftWidth, "…");
  const gap = " ".repeat(
    Math.max(
      minimumGap,
      width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
    ),
  );
  return truncateToWidth(fittedLeft + gap + fittedRight, width, "…");
}

export function layoutEditorPanel(
  baseLines: string[],
  outerWidth: number,
  panelWidth: number,
  metadata: string,
  styles: PanelStyles,
  placeholder?: string,
  attachments: readonly string[] = [],
): string[] {
  if (baseLines.length < 3) return baseLines;

  const margin = " ".repeat(
    Math.max(0, Math.floor((outerWidth - panelWidth) / 2)),
  );
  const innerWidth = Math.max(1, panelWidth - 1);
  const sidePadding = Math.min(
    MESSAGE_PADDING_X,
    Math.floor((innerWidth - 1) / 2),
  );
  const contentWidth = innerWidth - sidePadding * 2;
  const bottomBorder = baseLines.findIndex(
    (line, index) => index > 0 && line.includes("─"),
  );
  if (bottomBorder < 2) return baseLines;

  const fill = (content: string): string => {
    const safeContent = content.replaceAll(CURSOR_RESET, REVERSE_OFF);
    const fitted = truncateToWidth(safeContent, contentWidth, "").replaceAll(
      CURSOR_RESET,
      REVERSE_OFF,
    );
    const padding = " ".repeat(
      Math.max(0, contentWidth - visibleWidth(fitted)),
    );
    const sides = " ".repeat(sidePadding);
    return `${margin}${styles.border("│")}${styles.background(sides + fitted + padding + sides)}`;
  };

  const panel = [fill(" ".repeat(innerWidth))];
  for (let index = 1; index < bottomBorder; index++) {
    let line = baseLines[index] ?? "";
    if (placeholder && index === 1) {
      line = line.replace(
        `\x1b[7m \x1b[0m`,
        `\x1b[7m \x1b[0m${styles.placeholder(placeholder)}`,
      );
    }
    panel.push(fill(line));
  }
  if (
    attachments.length > 0 &&
    styles.attachmentBadge &&
    styles.attachmentFilename
  ) {
    panel.push(fill(""));
    let row = "";
    for (const attachment of attachments) {
      const item = `${styles.attachmentBadge(" file ")}${styles.attachmentFilename(` ${attachment} `)}`;
      const next = row ? `${row} ${item}` : item;
      if (row && visibleWidth(next) > contentWidth) {
        panel.push(fill(row));
        row = item;
      } else {
        row = next;
      }
    }
    if (row) panel.push(fill(row));
  }
  panel.push(fill(" ".repeat(innerWidth)));
  panel.push(fill(metadata));
  panel.push(fill(" ".repeat(innerWidth)));

  for (const line of baseLines.slice(bottomBorder + 1)) {
    panel.push(`${margin} ${truncateToWidth(line, innerWidth, "")}`);
  }

  return panel;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const relativeToHome = relative(resolve(home), resolvedCwd);
  const insideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function providerName(ctx: ExtensionContext): string {
  return ctx.model
    ? ctx.modelRegistry.getProviderDisplayName(ctx.model.provider)
    : "";
}

function editorMetadata(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  const parts: string[] = [];

  if (ctx.model) {
    parts.push(theme.fg("text", ctx.model.name));
    parts.push(theme.fg("muted", providerName(ctx)));
  }

  const thinking = pi.getThinkingLevel();
  if (thinking !== "off") {
    if (parts.length > 0) parts.push(theme.fg("dim", "·"));
    parts.push(theme.bold(theme.fg("warning", thinking)));
  }

  return parts.join(" ");
}

export class OpenCodeEditor extends CustomEditor {
  private attachmentIds: string[] = [];
  private bracketedPasteBuffer: string | undefined;
  private preserveAttachmentsDuringClear = false;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    private readonly interruptKeybindings: KeybindingsManager,
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly interruptConfirmation: InterruptConfirmation,
    private readonly attachmentRegistry: DraftAttachmentRegistry,
    private readonly onAttachmentsChanged: (paths: string[]) => void = () => {},
  ) {
    super(tui, editorTheme, interruptKeybindings, { paddingX: 2 });
  }

  private trackedAttachments(
    text: string,
  ): Array<TrackedAttachmentMarker & { path: string }> {
    return findTrackedAttachmentMarkers(text).flatMap((marker) => {
      const path = this.attachmentRegistry.get(marker.id);
      return path ? [{ ...marker, path }] : [];
    });
  }

  private getUndoStack(): { pop(): unknown } {
    return (this as unknown as { undoStack: { pop(): unknown } }).undoStack;
  }

  private reconcileAttachments(preserveDetached = false): void {
    const text = this.getText();
    const activeIds: string[] = [];
    const normalized = text.replace(
      ATTACHMENT_TRACKING_PATTERN,
      (source, label: string | undefined, encodedId: string | undefined) => {
        if (label === undefined || encodedId === undefined) return "";
        const id = decodeAttachmentId(encodedId);
        if (!this.attachmentRegistry.get(id)) return `[Image ${label}]`;
        if (!activeIds.includes(id)) activeIds.push(id);
        return source;
      },
    );

    if (normalized !== text) {
      super.setText(normalized);
      this.getUndoStack().pop();
    }

    if (!preserveDetached) {
      for (const id of this.attachmentIds) {
        if (!activeIds.includes(id)) this.attachmentRegistry.delete(id);
      }
      this.attachmentIds = activeIds;
    }

    this.onAttachmentsChanged(
      this.trackedAttachments(normalized).map(({ path }) => path),
    );
  }

  private attachmentId(path: string): string {
    const existing = this.attachmentIds.find(
      (id) => this.attachmentRegistry.get(id) === path,
    );
    if (existing) return existing;

    const id = this.attachmentRegistry.add(path);
    this.attachmentIds.push(id);
    return id;
  }

  private updateAttachments(
    references: readonly ImagePathReference[],
    text: string,
  ): void {
    this.reconcileAttachments();

    let prompt = text;
    for (const { source, path } of references) {
      const id = this.attachmentId(path);
      prompt = prompt.replaceAll(
        source,
        attachmentMarker(this.attachmentIds.indexOf(id), id),
      );
    }
    super.setText(prompt);
    this.reconcileAttachments();
  }

  private attachImagePath(text: string): boolean {
    const references = findImagePathReferences(text);
    if (references.length !== 1 || references[0]!.source !== text.trim()) {
      return false;
    }

    this.reconcileAttachments();
    const { path } = references[0]!;
    const id = this.attachmentId(path);
    const index = this.attachmentIds.indexOf(id);
    super.insertTextAtCursor(`${attachmentMarker(index, id)} `);
    this.reconcileAttachments();
    return true;
  }

  private attachImagePathsInEditor(preserveDetached = false): void {
    const text = this.getText();
    const references = findImagePathReferences(text);
    if (references.length > 0) {
      this.updateAttachments(references, text);
      return;
    }

    this.reconcileAttachments(preserveDetached);
  }

  override setText(text: string): void {
    super.setText(text);
    if (text.length > 0 || !this.preserveAttachmentsDuringClear) {
      this.reconcileAttachments();
    }
  }

  override insertTextAtCursor(text: string): void {
    if (!this.attachImagePath(text)) super.insertTextAtCursor(text);
  }

  private deleteAttachmentMarkerBackward(data: string): boolean {
    if (
      !matchesKey(data, "backspace") &&
      !matchesKey(data, "shift+backspace")
    ) {
      return false;
    }

    const { line, col } = this.getCursor();
    const beforeCursor = (this.getLines()[line] ?? "").slice(0, col);
    const marker = this.trackedAttachments(beforeCursor)
      .reverse()
      .find(({ source }) => beforeCursor.endsWith(source));
    if (!marker) return false;

    const markerStart = col - marker.source.length;
    let deletionSteps = 0;
    while (
      this.getCursor().line === line &&
      this.getCursor().col > markerStart
    ) {
      super.handleInput(data);
      deletionSteps++;
    }

    // The parent editor records one snapshot per grapheme deletion. Keep only
    // the first so the whole marker is one undo unit.
    const undoStack = this.getUndoStack();
    for (let index = 1; index < deletionSteps; index++) undoStack.pop();

    this.attachImagePathsInEditor();
    return true;
  }

  private isSubmitting(data: string): boolean {
    if (
      this.interruptKeybindings.matches(data, "app.message.followUp") &&
      this.getText().trim().length > 0
    ) {
      return true;
    }

    if (
      this.disableSubmit ||
      this.isShowingAutocomplete() ||
      !this.interruptKeybindings.matches(data, "tui.input.submit")
    ) {
      return false;
    }

    const { line, col } = this.getCursor();
    return col === 0 || (this.getLines()[line] ?? "")[col - 1] !== "\\";
  }

  override handleInput(data: string): void {
    const isInterrupt = this.interruptKeybindings.matches(
      data,
      "app.interrupt",
    );
    const shouldConfirm =
      isInterrupt && !this.isShowingAutocomplete() && !this.ctx.isIdle();

    if (shouldConfirm) {
      if (!this.interruptConfirmation.request()) return;
    } else {
      this.interruptConfirmation.clear();
    }

    if (this.deleteAttachmentMarkerBackward(data)) return;

    if (this.bracketedPasteBuffer === undefined) {
      const start = data.indexOf(BRACKETED_PASTE_START);
      if (start === -1) {
        const submitting = this.isSubmitting(data);
        this.preserveAttachmentsDuringClear = submitting;
        try {
          super.handleInput(data);
        } finally {
          this.preserveAttachmentsDuringClear = false;
        }
        this.attachImagePathsInEditor(
          submitting && this.getText().length === 0,
        );
        return;
      }
      if (start > 0) super.handleInput(data.slice(0, start));
      this.bracketedPasteBuffer = data.slice(
        start + BRACKETED_PASTE_START.length,
      );
    } else {
      this.bracketedPasteBuffer += data;
    }

    const end = this.bracketedPasteBuffer.indexOf(BRACKETED_PASTE_END);
    if (end === -1) return;

    const pastedText = this.bracketedPasteBuffer.slice(0, end);
    const remaining = this.bracketedPasteBuffer.slice(
      end + BRACKETED_PASTE_END.length,
    );
    this.bracketedPasteBuffer = undefined;

    if (!this.attachImagePath(pastedText)) {
      super.handleInput(
        `${BRACKETED_PASTE_START}${pastedText}${BRACKETED_PASTE_END}`,
      );
      this.attachImagePathsInEditor();
    }
    if (remaining) this.handleInput(remaining);
  }

  render(width: number): string[] {
    const targetWidth = promptWidth(width);
    const baseLines = super.render(Math.max(1, targetWidth - 1));
    const theme = this.ctx.ui.theme;

    return layoutEditorPanel(
      baseLines,
      width,
      targetWidth,
      editorMetadata(this.pi, this.ctx),
      {
        border: (text) => theme.fg("borderAccent", text),
        background: (text) => theme.bg("customMessageBg", text),
        placeholder: (text) => theme.fg("dim", text),
        attachmentBadge: (text) =>
          theme.inverse(theme.fg("accent", theme.bold(text))),
        attachmentFilename: (text) => theme.fg("muted", text),
      },
      this.getText().length === 0
        ? 'Ask anything... "Fix a TODO in the codebase"'
        : undefined,
      this.trackedAttachments(this.getText()).map(({ path }) => basename(path)),
    );
  }
}

function center(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return (
    " ".repeat(left) + truncateToWidth(text, Math.max(1, width - left), "")
  );
}

function installHeader(ctx: ExtensionContext): void {
  ctx.ui.setHeader((tui, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const topSpace = Math.max(2, Math.floor(tui.terminal.rows * 0.2));
      const lines = Array<string>(topSpace).fill("");
      for (const [left, right] of logo) {
        lines.push(
          center(
            theme.fg("muted", left) + theme.bold(theme.fg("text", right)),
            width,
          ),
        );
      }
      lines.push("");
      return lines;
    },
  }));
}

function registerNonStreamingBashTool(pi: ExtensionAPI, cwd: string): void {
  const bashTool = createBashToolDefinition(cwd);
  const renderCompleteCall = bashTool.renderCall;

  pi.registerTool({
    ...bashTool,
    renderCall(args, theme, context) {
      if (!context.argsComplete) {
        const text =
          context.lastComponent instanceof Text
            ? context.lastComponent
            : new Text("", 0, 0);
        text.setText("");
        return text;
      }

      return renderCompleteCall!(args, theme, context);
    },
  });
}

function styleScannerFrame(frame: string, theme: Theme): string {
  return Array.from(frame, (character) => {
    if (character === "■") return theme.fg("accent", character);
    if (character === "▪") return theme.fg("muted", character);
    return theme.fg("dim", character);
  }).join("");
}

function installFooter(
  ctx: ExtensionContext,
  getWorking: () => boolean,
  getWorkingSpinner: () => string,
  getInterruptConfirmation: () => boolean,
  setActiveTui: (tui: TUI) => void,
): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    setActiveTui(tui);
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const left = getWorking()
          ? `${styleScannerFrame(getWorkingSpinner(), theme)} ${theme.fg("text", keyText("app.interrupt"))} ${theme.fg("muted", interruptPrompt(getInterruptConfirmation()))}`
          : theme.fg("muted", formatCwd(ctx.cwd));

        const right: string[] = [...footerData.getExtensionStatuses().values()];
        const usage = ctx.getContextUsage();
        if (usage) {
          const percent =
            usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
          const tokens =
            usage.tokens === null ? "?" : formatTokens(usage.tokens);
          right.push(theme.fg("muted", `${tokens} (${percent})`));
        }
        right.push(
          `${theme.fg("text", keyText("app.thinking.cycle"))} ${theme.fg("muted", "thinking")}`,
          `${theme.fg("text", keyText("app.model.select"))} ${theme.fg("muted", "models")}`,
        );

        return [alignColumns(left, right.join("  "), width)];
      },
    };
  });
}

function turnMetaLine(data: TurnMeta, theme: Theme): string {
  const model = [data.model, data.provider].filter(Boolean).join(" ");
  return [
    theme.fg("accent", "▣"),
    theme.fg("muted", model),
    theme.fg("dim", "·"),
    theme.fg("muted", formatDuration(data.durationMs)),
  ].join(" ");
}

export function createClipboardAttachmentInputHandler(
  registry: DraftAttachmentRegistry,
): (event: InputEvent) => Promise<InputEventResult> {
  return async (event) => {
    if (event.source !== "interactive") return { action: "continue" };

    const snapshot = registry.capture(event.text);
    const references = [
      ...snapshot.references,
      ...findImagePathReferences(snapshot.text),
    ].filter(
      ({ path }, index, all) =>
        all.findIndex((reference) => reference.path === path) === index,
    );
    const attachments: ClipboardAttachment[] = [];
    for (const reference of references) {
      try {
        const attachment = await loadClipboardAttachment(reference);
        if (attachment) attachments.push(attachment);
      } catch {
        // Keep unreadable clipboard paths as plain text.
      }
    }

    const attachedPaths = new Set(attachments.map(({ path }) => path));
    let text = snapshot.text;
    for (const { source, path } of snapshot.references) {
      if (!attachedPaths.has(path)) text = text.replace(source, path);
    }

    if (attachments.length === 0) {
      return text === event.text
        ? { action: "continue" }
        : { action: "transform", text, images: event.images };
    }

    return {
      action: "transform",
      text: formatClipboardAttachmentPrompt(text, attachments),
      images: [
        ...(event.images ?? []),
        ...attachments.map(({ image }) => image),
      ],
    };
  };
}

export default function (pi: ExtensionAPI) {
  let attachmentTheme: Theme | undefined;
  let working = false;
  let workingSpinnerIndex = 0;
  let workingSpinnerTimer: ReturnType<typeof setInterval> | undefined;
  let activeTui: TUI | undefined;
  const interruptConfirmation = new InterruptConfirmation(() =>
    activeTui?.requestRender(),
  );
  const turnStartedAt = new Map<number, number>();
  const thoughtDurations = new Map<string, number>();
  const thinkingStartedAt = new Map<number, number>();
  const draftAttachments = new DraftAttachmentRegistry();
  let workingThought: string | undefined;

  const stopWorkingSpinner = () => {
    if (workingSpinnerTimer) clearInterval(workingSpinnerTimer);
    workingSpinnerTimer = undefined;
  };

  const rememberThought = (text: string, durationMs: number) => {
    thoughtDurations.delete(text);
    thoughtDurations.set(text, durationMs);
    while (thoughtDurations.size > MAX_TRACKED_THOUGHTS) {
      const oldest = thoughtDurations.keys().next().value;
      if (oldest === undefined) break;
      thoughtDurations.delete(oldest);
    }
  };

  const clearWorkingThought = (ctx: ExtensionContext) => {
    if (workingThought === undefined) return;
    workingThought = undefined;
    ctx.ui.setWorkingMessage();
  };

  pi.registerEntryRenderer<TurnMeta>(
    TURN_META_ENTRY,
    (entry, _options, theme) => {
      if (!entry.data) return undefined;
      return new Text(turnMetaLine(entry.data, theme), 1, 0);
    },
  );

  pi.registerMarkdownTransformer((markdown, context) => {
    const theme = attachmentTheme;
    if (context.messageType !== "user" || !theme) return markdown;

    return renderAttachmentFiles(markdown, {
      badge: (text) => theme.inverse(theme.fg("accent", theme.bold(text))),
      filename: (text) =>
        `${theme.getBgAnsi("customMessageBg")}${theme.fg("muted", text)}${theme.getBgAnsi("userMessageBg")}`,
    });
  });

  pi.on("input", createClipboardAttachmentInputHandler(draftAttachments));

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    attachmentTheme = ctx.ui.theme;
    installUserMessageBorder(ctx.ui.theme);
    registerNonStreamingBashTool(pi, ctx.cwd);
    installThinkingRenderer({
      theme: ctx.ui.theme,
      durations: thoughtDurations,
    });
    ctx.ui.setTitle(`pi · ${formatCwd(ctx.cwd)}`);
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setToolsExpanded(false);
    installHeader(ctx);
    installFooter(
      ctx,
      () => working,
      () => WORKING_SPINNER_FRAMES[workingSpinnerIndex]!,
      () => interruptConfirmation.isPending(),
      (tui) => {
        activeTui = tui;
      },
    );
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new OpenCodeEditor(
          tui,
          theme,
          keybindings,
          pi,
          ctx,
          interruptConfirmation,
          draftAttachments,
        ),
    );
  });

  pi.on("message_start", () => {
    thinkingStartedAt.clear();
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const streamed = event.assistantMessageEvent;

    switch (streamed.type) {
      case "thinking_start":
        thinkingStartedAt.set(streamed.contentIndex, Date.now());
        break;
      case "thinking_delta": {
        const block = streamed.partial.content[streamed.contentIndex];
        const title =
          block?.type === "thinking"
            ? streamingThoughtTitle(block.thinking)
            : undefined;
        if (!title || title === workingThought) break;
        workingThought = title;
        ctx.ui.setWorkingMessage(`Thinking: ${title}`);
        break;
      }
      case "thinking_end": {
        const startedAt = thinkingStartedAt.get(streamed.contentIndex);
        thinkingStartedAt.delete(streamed.contentIndex);
        const text = streamed.content.trim();
        if (text && startedAt !== undefined) {
          rememberThought(text, Date.now() - startedAt);
        }
        break;
      }
      case "text_start":
      case "toolcall_start":
        clearWorkingThought(ctx);
        break;
    }
  });

  pi.on("message_end", (_event, ctx) => {
    thinkingStartedAt.clear();
    clearWorkingThought(ctx);
  });

  pi.on("agent_start", () => {
    interruptConfirmation.clear();
    working = true;
    workingSpinnerIndex = 0;
    stopWorkingSpinner();
    workingSpinnerTimer = setInterval(() => {
      workingSpinnerIndex =
        (workingSpinnerIndex + 1) % WORKING_SPINNER_FRAMES.length;
      activeTui?.requestRender();
    }, WORKING_SPINNER_INTERVAL_MS);
    activeTui?.requestRender();
  });

  pi.on("agent_settled", (_event, ctx) => {
    interruptConfirmation.clear();
    working = false;
    stopWorkingSpinner();
    thinkingStartedAt.clear();
    clearWorkingThought(ctx);
    activeTui?.requestRender();
  });

  pi.on("turn_start", (event) => {
    turnStartedAt.set(event.turnIndex, event.timestamp);
  });

  pi.on("turn_end", (event, ctx) => {
    const startedAt = turnStartedAt.get(event.turnIndex);
    turnStartedAt.delete(event.turnIndex);
    if (event.message.role !== "assistant") return;

    const hasText = event.message.content.some(
      (content) => content.type === "text" && content.text.trim().length > 0,
    );
    const hasTools = event.message.content.some(
      (content) => content.type === "toolCall",
    );
    if (!hasText || hasTools) return;

    pi.appendEntry<TurnMeta>(TURN_META_ENTRY, {
      model: ctx.model?.name ?? "no model",
      provider: providerName(ctx),
      durationMs: Math.max(0, Date.now() - (startedAt ?? Date.now())),
    });
  });

  pi.on("session_shutdown", () => {
    interruptConfirmation.clear();
    attachmentTheme = undefined;
    draftAttachments.clear();
    working = false;
    stopWorkingSpinner();
    activeTui = undefined;
    turnStartedAt.clear();
  });
}
