import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const BOLD_TITLE = /\*\*([^*]+)\*\*/g;
const THOUGHT_BAR = "▏";
const BODY_INDENT = 2;

/** One run of consecutive thinking blocks, as Pi groups them for rendering. */
export interface ThoughtRun {
  blocks: string[];
  durationMs?: number;
}

export interface ThoughtStyles {
  collapsed(text: string): string;
  header(text: string): string;
  body(text: string): string;
  bar(text: string): string;
}

interface MessageContent {
  type: string;
  thinking?: string;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/**
 * Group consecutive thinking blocks exactly the way AssistantMessageComponent
 * does, so run indices line up with the components it creates.
 */
export function collectThoughtRuns(content: readonly MessageContent[]): string[][] {
  const runs: string[][] = [];

  for (let index = 0; index < content.length; index++) {
    if (content[index]?.type !== "thinking") continue;

    const blocks: string[] = [];
    for (; index < content.length; index++) {
      const item = content[index];
      if (item?.type !== "thinking") break;
      const thinking = (item.thinking ?? "").trim();
      if (thinking) blocks.push(thinking);
    }
    index--;

    if (blocks.length > 0) runs.push(blocks);
  }

  return runs;
}

function titles(text: string): string[] {
  return [...text.matchAll(BOLD_TITLE)].map((match) => match[1]!.trim()).filter(Boolean);
}

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.replace(/[*_`>#-]/g, "").trim())
    .find(Boolean);
}

/** Headline for a finished run: reasoning summaries lead with a bold title. */
export function thoughtTitle(text: string): string | undefined {
  return titles(text)[0] ?? firstLine(text);
}

/** Headline while a block streams in — the newest title wins. */
export function streamingThoughtTitle(text: string): string | undefined {
  return titles(text).at(-1) ?? firstLine(text);
}

export function thoughtBody(blocks: readonly string[]): string {
  return blocks
    .map((block) => block.replace(BOLD_TITLE, "$1").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function runDuration(
  blocks: readonly string[],
  durations: ReadonlyMap<string, number>,
): number | undefined {
  let total: number | undefined;
  for (const block of blocks) {
    const duration = durations.get(block);
    if (duration !== undefined) total = (total ?? 0) + duration;
  }
  return total;
}

export function renderThought(
  run: ThoughtRun,
  expanded: boolean,
  width: number,
  paddingX: number,
  styles: ThoughtStyles,
): string[] {
  const padding = " ".repeat(paddingX);
  const innerWidth = Math.max(1, width - paddingX * 2);
  const duration = run.durationMs === undefined ? undefined : formatDuration(run.durationMs);

  if (!expanded) {
    const title = thoughtTitle(run.blocks.join("\n\n"));
    const label = [`+ Thought${title ? `: ${title}` : ""}`, duration].filter(Boolean).join(" · ");
    return [padding + styles.collapsed(truncateToWidth(label, innerWidth, "…"))];
  }

  const header = ["- Thought", duration].filter(Boolean).join(" · ");
  const lines = [padding + styles.header(truncateToWidth(header, innerWidth, "…")), ""];

  const bodyWidth = Math.max(1, innerWidth - BODY_INDENT);
  const paragraphs = thoughtBody(run.blocks).split("\n\n");
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0) lines.push(padding + styles.bar(THOUGHT_BAR));
    for (const line of wrapTextWithAnsi(paragraph, bodyWidth)) {
      lines.push(`${padding}${styles.bar(THOUGHT_BAR)} ${styles.body(line)}`);
    }
  }

  return lines;
}
