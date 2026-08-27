const MIN_SAMPLE_MS = 1_000;
const REFRESH_INTERVAL_MS = 300;

function computeRate(outputTokens: number, elapsedMs: number): number {
  return Math.round((outputTokens * 1_000) / elapsedMs);
}

/**
 * Samples the assistant message's cumulative output tokens into a
 * tokens-per-second rate, holding the last completed rate between samples.
 */
export class TpsTracker {
  private startedAt: number | undefined;
  private outputTokens = 0;
  private lastRefreshAt = 0;
  private rate: number | undefined;

  start(now: number): void {
    this.startedAt = now;
    this.outputTokens = 0;
    this.lastRefreshAt = now;
  }

  observe(outputTokens: number | undefined, now: number): void {
    if (this.startedAt === undefined || outputTokens === undefined) return;
    this.outputTokens = outputTokens;

    const elapsedMs = now - this.startedAt;
    if (
      this.outputTokens === 0 ||
      elapsedMs < MIN_SAMPLE_MS ||
      now - this.lastRefreshAt < REFRESH_INTERVAL_MS
    ) {
      return;
    }

    this.lastRefreshAt = now;
    this.rate = computeRate(this.outputTokens, elapsedMs);
  }

  tokensPerSecond(): number | undefined {
    return this.rate;
  }

  /** Closes out the message, folding in the final usage sample if one arrived. */
  stop(finalOutputTokens: number | undefined, now: number): void {
    this.observe(finalOutputTokens, now);

    const startedAt = this.startedAt;
    this.startedAt = undefined;
    if (startedAt === undefined || this.outputTokens === 0) return;

    const elapsedMs = now - startedAt;
    if (elapsedMs >= MIN_SAMPLE_MS) {
      this.rate = computeRate(this.outputTokens, elapsedMs);
    }
  }
}
