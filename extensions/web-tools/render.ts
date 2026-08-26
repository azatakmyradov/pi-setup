import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateLines } from "../shared/ui-kit.ts";

export function getTextContent(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && item.text !== undefined,
    )
    .map((item) => item.text)
    .join("\n");
}

export function appendExpandedPreview(
  base: string,
  text: string,
  theme: {
    fg: (name: string, value: string) => string;
  },
  options: { maxLines?: number; maxColumns?: number } = {},
): string {
  const maxLines = options.maxLines ?? 12;
  const maxColumns = options.maxColumns ?? 200;
  // truncateLines appends a lone `…` line, the same cut marker every other
  // collapsed preview in the TUI uses.
  for (const line of truncateLines(text.split("\n"), maxLines)) {
    base += `\n${theme.fg("dim", line.slice(0, maxColumns))}`;
  }
  return base;
}

export function appendExpandHint(base: string, expanded: boolean): string {
  if (expanded) return base;
  return `${base} · ${keyHint("app.tools.expand", "details")}`;
}
