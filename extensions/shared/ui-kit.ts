import { keyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];
type ThemeColor = Parameters<Theme["fg"]>[0];

/**
 * The single theme capability the status helpers need: coloring text. Accepting
 * this instead of the whole `Theme` class keeps them callable with any themer,
 * including the plain-text one the tests use.
 */
export type ThemeText = Pick<Theme, "fg">;

/**
 * Shared glyph vocabulary. Every extension should use these instead of
 * ad-hoc literals so status semantics look identical across the TUI.
 */
export const LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export const glyphs = {
  success: "✓",
  error: "✗",
  warning: "▲",
  running: "●",
  pending: "○",
  progress: "⋯",
  selectPrefix: "❯",
  /** Decorative list bullet with no status meaning. */
  bullet: "•",
} as const;

/** Inline separators. `dot` joins stats, `pipe` groups sections. */
export const separators = {
  dot: "·",
  pipe: "│",
  dash: "─",
} as const;

export type StatusState = "success" | "error" | "warning" | "running" | "pending";

/** GitHub-style mapping: running/pending work is yellow, like CI checks. */
const statusColors = {
  success: "success",
  error: "error",
  warning: "warning",
  running: "warning",
  pending: "dim",
} satisfies Record<StatusState, ThemeColor>;

export function statusColor(state: StatusState): ThemeColor {
  return statusColors[state];
}

/** Themed status glyph, e.g. a green ✓ for "success". */
export function statusGlyph(theme: ThemeText, state: StatusState): string {
  return theme.fg(statusColors[state], glyphs[state]);
}

/** Full-width accent divider used to frame dialogs and sections. */
export function dividerLine(theme: Theme, width: number): string {
  return theme.fg("accent", separators.dash.repeat(Math.max(0, width)));
}

/** Standard SelectList colors — pass to every `new SelectList(...)`. */
export function selectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
}

/** Dim label followed by a pre-colored value: `ctx 42%/200k`. */
export function dimLabel(theme: Theme, label: string, value: string): string {
  return `${theme.fg("dim", label)} ${value}`;
}

/**
 * Standard help line. Plain strings render dim; `[key, label]` tuples render
 * two-tone (key in `text`, label in `muted`) — the convention for every hint:
 * `↑↓ navigate · enter select · esc cancel`.
 */
export function helpLine(theme: ThemeText, hints: ReadonlyArray<Hint>): string {
  const rendered = hints.map((hint) =>
    isKeyLabel(hint) ? keyLabel(theme, hint[0], hint[1]) : theme.fg("dim", hint),
  );
  return rendered.join(theme.fg("dim", ` ${separators.dot} `));
}

/** A help-line entry: plain dim text, or a `[key, label]` pair rendered two-tone. */
export type Hint = string | readonly [string, string];

function isKeyLabel(hint: Hint): hint is readonly [string, string] {
  return Array.isArray(hint);
}

/** Join already-colored parts with a dim dot separator. */
export function joinStatus(theme: ThemeText, parts: string[]): string {
  return parts.join(theme.fg("dim", ` ${separators.dot} `));
}

// ---------------------------------------------------------------------------
// Layout, truncation, and hint helpers shared by every extension. Added so the
// TUI reads as one system: one gutter glyph, one hint convention, one token
// format, one truncation rule. Prefer these over local copies.
// ---------------------------------------------------------------------------

/** Heavy left gutter bar; color carries the meaning (accent, warning, error…). */
export const GUTTER = "┃";

/** Continuation arrow for follow-up detail lines under a tool row. */
export const CONTINUATION = "↳";

/** Standard number of preview lines before a collapsed tool result is cut. */
export const PREVIEW_LINES = 10;

/**
 * Compact token count: `950`, `1.2k`, `45k`, `1.2M`, `12M`. The single
 * canonical formatter — footer, status line, and dashboards must all agree.
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/**
 * Left/right aligned single line. When both columns compete for space the
 * right one is capped at `rightBudget` of the width (default 60%) and the left
 * is truncated to fit; when the left column is short the right may use the
 * remaining room in full.
 */
export function alignColumns(
  left: string,
  right: string,
  width: number,
  rightBudget = 0.6,
): string {
  if (width <= 0) return "";
  if (!right) return truncateToWidth(left, width, "…");

  const minGap = 2;
  const budgetCap = Math.floor(width * rightBudget);
  const roomBesideLeft = width - visibleWidth(left) - minGap;
  const rightCap = Math.max(1, Math.min(width, Math.max(budgetCap, roomBesideLeft)));
  const fittedRight = truncateToWidth(right, rightCap, "…");
  const rightWidth = visibleWidth(fittedRight);
  const leftWidth = width - rightWidth - minGap;
  if (leftWidth <= 0) return truncateToWidth(fittedRight, width, "…");

  const fittedLeft = truncateToWidth(left, leftWidth, "…");
  const gap = " ".repeat(Math.max(minGap, width - visibleWidth(fittedLeft) - rightWidth));
  return fittedLeft + gap + fittedRight;
}

/**
 * Cut `lines` to at most `max`, appending a lone `…` line when anything was
 * dropped. Mirrors the collapsed-output rule used for every tool preview.
 */
export function truncateLines(lines: readonly string[], max = PREVIEW_LINES): string[] {
  if (lines.length <= max) return [...lines];
  return [...lines.slice(0, Math.max(0, max - 1)), "…"];
}

/** `ctrl+o expand` using the user's real keybinding — never hardcode the key. */
export function expandHint(label = "expand"): string {
  return keyHint("app.tools.expand", label);
}

/** A single `key label` pair: key in `text`, label in `muted`, key first. */
export function keyLabel(theme: ThemeText, key: string, label: string): string {
  return `${theme.fg("text", key)} ${theme.fg("muted", label)}`;
}

/**
 * Prefix each line with the gutter bar in `color`. Use for user messages,
 * blocks, thinking bodies, and inline prompts instead of drawing boxes.
 */
export function gutterLines(
  theme: ThemeText,
  lines: readonly string[],
  color: ThemeColor = "borderAccent",
): string[] {
  const bar = theme.fg(color, GUTTER);
  return lines.map((line) => `${bar} ${line}`);
}

/**
 * Dialog/overlay header: bold title on the left, muted dismiss hint on the
 * right (`esc` by default), fitted to `width`.
 */
export function panelHeader(
  theme: Pick<Theme, "fg" | "bold">,
  title: string,
  width: number,
  right = "esc",
): string {
  return alignColumns(theme.bold(theme.fg("text", title)), theme.fg("muted", right), width, 0.3);
}

/** Denied / cancelled / dismissed: struck through and muted, not red. Red is for failures. */
export function deniedText(theme: Pick<Theme, "fg" | "strikethrough">, text: string): string {
  return theme.strikethrough(theme.fg("muted", text));
}

/** A keybinding id accepted by `KeybindingsManager.getKeys`. */
export type KeybindingId = Parameters<KeybindingsManager["getKeys"]>[0];

/** The user's configured keys for `binding`, joined with `/`; `unbound` when none. */
/** The only keybinding capability the hint helpers need. */
export type KeyLookup = Pick<KeybindingsManager, "getKeys">;

export function configuredKeys(keybindings: KeyLookup, binding: KeybindingId): string {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

/** `[key, label]` hint tuple for a keybinding id — feed straight into `helpLine`. */
export function keyLabelFor(
  keybindings: KeyLookup,
  binding: KeybindingId,
  label: string,
): readonly [string, string] {
  return [configuredKeys(keybindings, binding), label];
}

/**
 * Collapsed tool-result text: `header`, then up to `max` body lines in
 * `toolOutput`, then the expand hint when anything was cut. The one shape for
 * every collapsed result renderer.
 */
export function collapsedPreview(
  theme: ThemeText,
  header: string,
  body: string,
  max = PREVIEW_LINES,
): string {
  const lines = body.split("\n");
  const preview = truncateLines(lines, max);
  let text = header;
  for (const line of preview) text += `\n${theme.fg("toolOutput", line)}`;
  if (preview.length < lines.length) text += `\n${expandHint()}`;
  return text;
}
