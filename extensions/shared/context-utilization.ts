/** Compact, defensive context-window utilization formatting for child agents. */

import { formatTokens } from "./ui-kit.ts";

/** Alias of the kit's canonical token formatter, kept for existing importers. */
export const formatCompactTokens = formatTokens;

export interface ContextUtilization {
  /** Current conversation context occupancy; null while it is unknown after compaction. */
  tokens?: number | null;
  /** Capacity of the model currently serving the conversation. */
  contextWindow?: number | null;
}

function usableTokens(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usableCapacity(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function contextPercent(usage: ContextUtilization) {
  const tokens = usableTokens(usage.tokens);
  const capacity = usableCapacity(usage.contextWindow);
  if (tokens === undefined || capacity === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, (tokens / capacity) * 100)));
}

/**
 * Render `%/capacity`. If occupancy is temporarily unknown (notably directly
 * after compaction), retain the useful model capacity as `?%/capacity`. If no
 * valid capacity is available, omit the statistic because no percentage can
 * be computed.
 */
export function formatContextUtilization(usage: ContextUtilization) {
  const capacity = usableCapacity(usage.contextWindow);
  if (capacity === undefined) return "";
  const percent = contextPercent(usage);
  return `${percent === undefined ? "?" : percent}%/${formatTokens(capacity)}`;
}
