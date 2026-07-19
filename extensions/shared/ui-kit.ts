import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectListTheme } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];
type ThemeColor = Parameters<Theme["fg"]>[0];

/**
 * Shared glyph vocabulary. Every extension should use these instead of
 * ad-hoc literals so status semantics look identical across the TUI.
 */
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
const statusColors: Record<StatusState, ThemeColor> = {
  success: "success",
  error: "error",
  warning: "warning",
  running: "warning",
  pending: "dim",
};

export function statusColor(state: StatusState): ThemeColor {
  return statusColors[state];
}

/** Themed status glyph, e.g. a green ✓ for "success". */
export function statusGlyph(theme: Theme, state: StatusState): string {
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

/** Standard dim help line: `↑↓ navigate · enter select · esc cancel`. */
export function helpLine(theme: Theme, hints: string[]): string {
  return theme.fg("dim", hints.join(` ${separators.dot} `));
}

/** Join already-colored parts with a dim dot separator. */
export function joinStatus(theme: Theme, parts: string[]): string {
  return parts.join(theme.fg("dim", ` ${separators.dot} `));
}
