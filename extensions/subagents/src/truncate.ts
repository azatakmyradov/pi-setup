/**
 * Head+tail truncation for subagent output.
 *
 * A subagent's conclusion is at the end of its final message, so pi's
 * `truncateHead` (first N lines/bytes) drops exactly the part the parent model
 * needs. This keeps a head and a tail around an explicit marker, bounded by
 * both a byte and a line budget, and never splits a UTF-8 code point.
 */

const DEFAULT_TAIL_SHARE = 1 / 3;

export interface TruncateHeadTailOptions {
  readonly maxBytes: number;
  readonly maxLines: number;
  /** Fraction of both budgets reserved for the tail (default: one third). */
  readonly tailShare?: number;
  /** Named in the marker so the reader can find the full text. */
  readonly sessionFilePath?: string;
}

export interface TruncateHeadTailResult {
  readonly text: string;
  readonly truncated: boolean;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** Longest prefix of whole code points that fits `maxBytes`. */
function codePointPrefix(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const codePoint of text) {
    const size = byteLength(codePoint);
    if (used + size > maxBytes) break;
    used += size;
    out += codePoint;
  }
  return out;
}

/** Longest suffix of whole code points that fits `maxBytes`. */
function codePointSuffix(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const codePoints = Array.from(text);
  let used = 0;
  let start = codePoints.length;
  for (let index = codePoints.length - 1; index >= 0; index--) {
    const size = byteLength(codePoints[index] ?? "");
    if (used + size > maxBytes) break;
    used += size;
    start = index;
  }
  return codePoints.slice(start).join("");
}

function buildMarker(
  omittedLines: number,
  omittedBytes: number,
  sessionFilePath: string | undefined,
): string {
  const where = sessionFilePath ? `; full transcript in ${sessionFilePath}` : "";
  return `[… omitted ${omittedLines} lines / ${omittedBytes} bytes${where} …]`;
}

/**
 * Keep the first `1 - tailShare` and the last `tailShare` of both budgets,
 * with one marker line in between. Returns the input unchanged when it already
 * fits.
 */
export function truncateHeadTail(
  text: string,
  options: TruncateHeadTailOptions,
): TruncateHeadTailResult {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes));
  const maxLines = Math.max(1, Math.floor(options.maxLines));
  const tailShare = Math.min(1, Math.max(0, options.tailShare ?? DEFAULT_TAIL_SHARE));

  const totalBytes = byteLength(text);
  const lines = text.split("\n");
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { text, truncated: false };
  }

  const tailLineBudget = tailShare === 0 ? 0 : Math.max(1, Math.round(maxLines * tailShare));
  const headLineBudget = Math.max(1, maxLines - tailLineBudget);
  const tailByteBudget = tailShare === 0 ? 0 : Math.max(1, Math.round(maxBytes * tailShare));
  const headByteBudget = Math.max(1, maxBytes - tailByteBudget);

  // Whole lines only, from both ends, stopping at whichever budget runs out.
  let headEnd = 0;
  let headBytes = 0;
  while (headEnd < lines.length && headEnd < headLineBudget) {
    const cost = byteLength(lines[headEnd] ?? "") + 1;
    if (headBytes + cost > headByteBudget) break;
    headBytes += cost;
    headEnd++;
  }

  let tailStart = lines.length;
  let tailBytes = 0;
  // Never let the tail reach the first line: that line is the head's
  // code-point fallback when it alone blows the head budget.
  const tailFloor = Math.max(headEnd, 1);
  while (tailStart > tailFloor && lines.length - tailStart < tailLineBudget) {
    const cost = byteLength(lines[tailStart - 1] ?? "") + 1;
    if (tailBytes + cost > tailByteBudget) break;
    tailBytes += cost;
    tailStart--;
  }

  // One line longer than its whole budget: fall back to code points so the
  // result is never empty (and never a split code point).
  const headText =
    headEnd > 0
      ? lines.slice(0, headEnd).join("\n")
      : codePointPrefix(lines[0] ?? "", headByteBudget);
  const tailText =
    tailStart < lines.length
      ? lines.slice(tailStart).join("\n")
      : tailByteBudget > 0
        ? codePointSuffix(lines[lines.length - 1] ?? "", tailByteBudget)
        : "";

  const omittedLines = Math.max(0, tailStart - headEnd);
  const omittedBytes = Math.max(0, totalBytes - byteLength(headText) - byteLength(tailText));
  const marker = buildMarker(omittedLines, omittedBytes, options.sessionFilePath);

  return {
    text: [headText, marker, tailText].filter((part) => part !== "").join("\n"),
    truncated: true,
  };
}
