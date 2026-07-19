import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { joinStatus, statusGlyph } from "./ui-kit.ts";

type Theme = ExtensionContext["ui"]["theme"];

interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
}

export function formatActivityStatus(
  theme: Theme,
  label: "subagents" | "workflows",
  counts: ActivityCounts,
) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(
      `${statusGlyph(theme, "running")} ${theme.fg("warning", `${counts.running} running`)}`,
    );
  }
  if (counts.done > 0) {
    parts.push(
      `${statusGlyph(theme, "success")} ${theme.fg("success", `${counts.done} done`)}`,
    );
  }
  if (counts.failed > 0) {
    parts.push(
      `${statusGlyph(theme, "error")} ${theme.fg("error", `${counts.failed} failed`)}`,
    );
  }
  parts.push(theme.fg("accent", `/${label}`) + theme.fg("dim", " to view"));

  return `${theme.fg("muted", `${label}:`)} ${joinStatus(theme, parts)}`;
}
