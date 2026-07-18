import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { extractJson } from "../shared/subagent.ts";
import {
  getTrackedSubagentHost,
  type TrackedSubagentHost,
  type TrackedSubagentSpawnRequest,
} from "../shared/tracked-subagent.ts";
import {
  appendReviewSchemaInstruction,
  formatReviewOutput,
  parseReviewOutput,
  type ReviewFinding,
  type ReviewOutput,
} from "../review/index.ts";
import {
  formatElapsed,
  type SubagentSnapshot,
} from "../subagents/src/domain.ts";
import { buildTranscriptLines } from "../subagents/src/ui/transcript.ts";

const REVIEW_RUBRIC = readFileSync(
  new URL("../review/rubric.md", import.meta.url),
  "utf8",
).trim();

const REVIEW_MODEL = "openai-codex/gpt-5.6-sol";
const VERIFIER_MODEL = "fable";
const FIX_MODEL = "openai-codex/gpt-5.6-sol";
const MAX_ITERATIONS = 5;
const RESULT_MESSAGE_TYPE = "review-fix-loop-result";
const REVIEW_TOOLS = ["read", "grep", "find", "ls"] as const;
const VERIFY_TOOLS = ["read", "grep", "find", "ls"] as const;
const FIX_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
] as const;

export interface VerificationVerdict {
  finding_index: number;
  verdict: "confirmed" | "rejected";
  explanation: string;
}

export interface VerificationOutput {
  verdicts: VerificationVerdict[];
  overall_explanation: string;
}

export interface RejectedFinding {
  finding: ReviewFinding;
  explanation: string;
}

export interface LoopModels {
  review: string;
  verify: string;
  fix: string;
}

export interface LoopStageEvent {
  iteration: number;
  stage: "review" | "verify" | "fix";
  snapshot: SubagentSnapshot;
}

export type ReviewFixLoopOutcome =
  | {
      status: "clean";
      iterations: number;
      fixPasses: number;
      finalReview: ReviewOutput;
    }
  | {
      status: "max_iterations";
      iterations: number;
      fixPasses: number;
      finalReview: ReviewOutput;
    }
  | {
      status: "stopped";
      iterations: number;
      fixPasses: number;
    };

export interface ReviewFixLoopOptions {
  host: TrackedSubagentHost;
  cwd: string;
  parent: TrackedSubagentSpawnRequest["parent"];
  instructions?: string;
  models?: Partial<LoopModels>;
  maxIterations?: number;
  shouldStop?: () => boolean;
  isParentIdle?: () => boolean;
  getReviewContext?: () => Promise<string>;
  onStageStarted?: (event: LoopStageEvent) => void;
}

export const VERIFICATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          finding_index: { type: "integer", minimum: 0 },
          verdict: { type: "string", enum: ["confirmed", "rejected"] },
          explanation: { type: "string" },
        },
        required: ["finding_index", "verdict", "explanation"],
        additionalProperties: false,
      },
    },
    overall_explanation: { type: "string" },
  },
  required: ["verdicts", "overall_explanation"],
  additionalProperties: false,
};

function isVerificationOutput(value: unknown): value is VerificationOutput {
  if (!value || typeof value !== "object") return false;
  const output = value as Partial<VerificationOutput>;
  return (
    Array.isArray(output.verdicts) &&
    output.verdicts.every(
      (verdict) =>
        !!verdict &&
        typeof verdict === "object" &&
        Number.isInteger(verdict.finding_index) &&
        (verdict.verdict === "confirmed" || verdict.verdict === "rejected") &&
        typeof verdict.explanation === "string",
    ) &&
    typeof output.overall_explanation === "string"
  );
}

export function parseVerificationOutput(
  text: string,
  findingCount: number,
): VerificationOutput {
  const output = extractJson(text);
  if (!isVerificationOutput(output)) {
    throw new Error("Verifier returned an invalid structured result");
  }

  const indices = output.verdicts.map((verdict) => verdict.finding_index);
  const expected = Array.from({ length: findingCount }, (_, index) => index);
  const sorted = [...indices].sort((left, right) => left - right);
  if (
    sorted.length !== expected.length ||
    sorted.some((index, position) => index !== expected[position])
  ) {
    throw new Error(
      `Verifier must return exactly one verdict for each finding index (expected 0-${Math.max(0, findingCount - 1)})`,
    );
  }

  return output;
}

function rejectedFeedback(rejected: RejectedFinding[]): string {
  if (rejected.length === 0) return "";
  const recent = rejected.slice(-20).map(({ finding, explanation }, index) => ({
    prior_rejection: index + 1,
    title: finding.title,
    body: finding.body,
    code_location: finding.code_location,
    verifier_explanation: explanation,
  }));
  return [
    "",
    "## Findings rejected by the independent verifier in earlier iterations",
    "Do not repeat these findings unless the code has changed or you can provide new, concrete evidence that addresses the verifier's explanation.",
    JSON.stringify(recent, null, 2),
  ].join("\n");
}

export function buildReviewPrompt(
  instructions = "",
  rejected: RejectedFinding[] = [],
  gitContext = "",
): string {
  const task = [
    "Review the current uncommitted changes in this Git worktree.",
    "The parent captured Git status and the tracked diff below. Inspect relevant files and untracked paths with the read-only tools provided.",
    "Only report actionable bugs introduced by the current uncommitted changes. You have no mutation-capable tools.",
    gitContext.trim()
      ? `## Captured Git status and diff\n\n${gitContext.trim()}`
      : "",
    instructions.trim()
      ? `Additional instructions: ${instructions.trim()}`
      : "",
    rejectedFeedback(rejected),
  ]
    .filter(Boolean)
    .join("\n\n");

  return appendReviewSchemaInstruction(
    `${REVIEW_RUBRIC}\n\n---\n\n## Review task\n\n${task}`,
  );
}

export function buildVerificationPrompt(review: ReviewOutput): string {
  return [
    "You are the independent verifier in a review-verify-fix loop.",
    "This is a strictly read-only task: do not edit, create, delete, format, or commit files, and do not run commands that mutate the worktree.",
    "The proposed findings came from a diff-aware reviewer. Inspect the referenced code, tests, and call sites. Independently determine whether each finding is a real, actionable bug introduced by the current uncommitted changes.",
    "Confirm a finding only when the code supports it. Reject speculation, pre-existing issues, intentional behavior, style-only concerns, and findings whose cited location is not part of the relevant change.",
    "Return exactly one verdict for every finding index. Keep each explanation concise and evidence-based.",
    "",
    "## Proposed review findings",
    JSON.stringify(
      review.findings.map((finding, finding_index) => ({
        finding_index,
        ...finding,
      })),
      null,
      2,
    ),
    "",
    "---",
    "Respond with ONLY one JSON object matching this JSON schema, with no prose before or after it.",
    `Schema: ${JSON.stringify(VERIFICATION_SCHEMA)}`,
  ].join("\n");
}

export function buildFixPrompt(
  review: ReviewOutput,
  verification: VerificationOutput,
): string {
  const confirmed = verification.verdicts
    .filter((verdict) => verdict.verdict === "confirmed")
    .map((verdict) => ({
      finding: review.findings[verdict.finding_index],
      verifier_explanation: verdict.explanation,
    }));

  return [
    "You are the fixer in a review-verify-fix loop.",
    "Inspect the current worktree and implement focused fixes for every confirmed finding below.",
    "Preserve unrelated user changes, follow the repository instructions, do not commit, and run the narrowest relevant tests or checks after editing.",
    "Do not fix rejected findings or perform unrelated refactors. If a confirmed finding cannot be fixed safely, leave the surrounding work intact and explain why in your final response.",
    "",
    "## Confirmed findings",
    JSON.stringify(confirmed, null, 2),
  ].join("\n");
}

function assertCompleted(snapshot: SubagentSnapshot, stage: string): void {
  if (snapshot.status === "done") return;
  throw new Error(
    `${stage} subagent ${snapshot.id} failed: ${snapshot.errorText ?? "no result"}`,
  );
}

async function spawnAndWait(
  host: TrackedSubagentHost,
  request: TrackedSubagentSpawnRequest,
  onStarted?: (snapshot: SubagentSnapshot) => void,
): Promise<SubagentSnapshot> {
  return new Promise<SubagentSnapshot>((resolve, reject) => {
    let settled = false;
    host
      .spawn({
        ...request,
        onSettled(snapshot) {
          if (!settled) {
            settled = true;
            resolve(snapshot);
          }
          return true;
        },
      })
      .then((snapshot) => {
        onStarted?.(snapshot);
        if (snapshot.status !== "running" && !settled) {
          settled = true;
          resolve(snapshot);
        }
      }, reject);
  });
}

export async function runReviewFixLoop(
  options: ReviewFixLoopOptions,
): Promise<ReviewFixLoopOutcome> {
  const models: LoopModels = {
    review: options.models?.review ?? REVIEW_MODEL,
    verify: options.models?.verify ?? VERIFIER_MODEL,
    fix: options.models?.fix ?? FIX_MODEL,
  };
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const shouldStop = options.shouldStop ?? (() => false);
  const isParentIdle = options.isParentIdle ?? (() => true);
  const assertParentIdle = () => {
    if (!isParentIdle()) {
      throw new Error(
        "The parent agent became active while the review-fix loop was running",
      );
    }
  };
  const rejected: RejectedFinding[] = [];
  let fixPasses = 0;
  let finalReview: ReviewOutput | undefined;

  const reviewOnce = async (iteration: number, title: string) => {
    assertParentIdle();
    const gitContext = await options.getReviewContext?.();
    const snapshot = await spawnAndWait(
      options.host,
      {
        backend: "pi",
        prompt: buildReviewPrompt(options.instructions, rejected, gitContext),
        title,
        cwd: options.cwd,
        model: models.review,
        reasoningEffort: "high",
        tools: REVIEW_TOOLS,
        parent: options.parent,
      },
      (started) =>
        options.onStageStarted?.({
          iteration,
          stage: "review",
          snapshot: started,
        }),
    );
    if (shouldStop()) return undefined;
    assertCompleted(snapshot, "Review");
    return parseReviewOutput(snapshot.finalText);
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (shouldStop()) {
      return { status: "stopped", iterations: iteration - 1, fixPasses };
    }

    const reviewResult = await reviewOnce(
      iteration,
      `review-fix loop ${iteration}/${maxIterations}: review`,
    );
    if (!reviewResult) {
      return { status: "stopped", iterations: iteration - 1, fixPasses };
    }
    finalReview = reviewResult;
    if (finalReview.findings.length === 0) {
      return {
        status: "clean",
        iterations: iteration,
        fixPasses,
        finalReview,
      };
    }

    assertParentIdle();
    const verificationSnapshot = await spawnAndWait(
      options.host,
      {
        backend: "claude",
        prompt: buildVerificationPrompt(finalReview),
        title: `review-fix loop ${iteration}/${maxIterations}: verify`,
        cwd: options.cwd,
        model: models.verify,
        reasoningEffort: "high",
        tools: VERIFY_TOOLS,
        parent: options.parent,
      },
      (snapshot) =>
        options.onStageStarted?.({ iteration, stage: "verify", snapshot }),
    );
    if (shouldStop()) {
      return { status: "stopped", iterations: iteration, fixPasses };
    }
    assertCompleted(verificationSnapshot, "Verifier");
    const verification = parseVerificationOutput(
      verificationSnapshot.finalText,
      finalReview.findings.length,
    );

    const confirmed = verification.verdicts.filter(
      (verdict) => verdict.verdict === "confirmed",
    );
    for (const verdict of verification.verdicts) {
      if (verdict.verdict !== "rejected") continue;
      const finding = finalReview.findings[verdict.finding_index];
      if (finding) rejected.push({ finding, explanation: verdict.explanation });
    }

    if (confirmed.length === 0) continue;
    // The last review is diagnostic only so every automated fix is followed
    // by another independent review within the safety cap.
    if (iteration === maxIterations) break;

    assertParentIdle();
    const fixSnapshot = await spawnAndWait(
      options.host,
      {
        backend: "pi",
        prompt: buildFixPrompt(finalReview, verification),
        title: `review-fix loop ${iteration}/${maxIterations}: fix`,
        cwd: options.cwd,
        model: models.fix,
        reasoningEffort: "high",
        tools: FIX_TOOLS,
        parent: options.parent,
      },
      (snapshot) =>
        options.onStageStarted?.({ iteration, stage: "fix", snapshot }),
    );

    const fixerCompleted = fixSnapshot.status === "done";
    if (fixerCompleted) fixPasses++;
    if (shouldStop()) {
      return {
        status: "stopped",
        iterations: iteration,
        fixPasses,
      };
    }
    if (!fixerCompleted) {
      // A fixer may have changed files even when it fails, so do not release
      // the worktree lock until a final read-only review records its state.
      const safetyReview = await reviewOnce(
        iteration,
        `review-fix loop ${iteration}/${maxIterations}: fixer safety review`,
      );
      if (!safetyReview) {
        return {
          status: "stopped",
          iterations: iteration,
          fixPasses,
        };
      }
      finalReview = safetyReview;
      const failure = fixSnapshot.errorText ?? "no result";
      throw new Error(
        `Fixer subagent ${fixSnapshot.id} failed: ${failure}\n\nSafety review:\n${formatReviewOutput(finalReview)}`,
      );
    }
  }

  if (!finalReview) {
    return { status: "stopped", iterations: 0, fixPasses };
  }
  return {
    status: "max_iterations",
    iterations: maxIterations,
    fixPasses,
    finalReview,
  };
}

interface ActiveLoop {
  id: number;
  stopRequested: boolean;
  stage?: LoopStageEvent;
  forceStop?: () => void;
}

const TRANSCRIPT_SCROLL_STEP = 6;
const MONITOR_POLL_MS = 100;

/**
 * A read-only live view of the current loop stage. Unlike BorderedLoader, this
 * keeps the exclusive input gate while exposing the child agent's reasoning,
 * tool calls, and tool output as they arrive.
 */
class ReviewFixLoopMonitor implements Component {
  private stage?: LoopStageEvent;
  private snapshot?: SubagentSnapshot;
  private scrollOffset = 0;
  private pollInFlight = false;
  private pollError?: string;
  private stopped = false;
  private readonly ticker: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly host: TrackedSubagentHost,
    private readonly getStage: () => LoopStageEvent | undefined,
    private readonly isStopping: () => boolean,
    private readonly requestStop: () => void,
  ) {
    this.setStage(getStage());
    this.ticker = setInterval(() => void this.poll(), MONITOR_POLL_MS);
    void this.poll();
  }

  private setStage(stage: LoopStageEvent | undefined): void {
    if (stage?.snapshot.id === this.stage?.snapshot.id) return;
    this.stage = stage;
    this.snapshot = stage?.snapshot;
    this.scrollOffset = 0;
    this.pollError = undefined;
    this.tui.requestRender();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      this.setStage(this.getStage());
      const id = this.stage?.snapshot.id;
      if (id) {
        const latest = (await this.host.list()).find(
          (snapshot) => snapshot.id === id,
        );
        if (latest) this.snapshot = latest;
      }
      this.pollError = undefined;
    } catch (error) {
      this.pollError = error instanceof Error ? error.message : String(error);
    } finally {
      this.pollInFlight = false;
      if (!this.stopped) this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "app.clear")
    ) {
      this.requestStop();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.bodyHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.bodyHeight());
      this.tui.requestRender();
    }
  }

  private bodyHeight(): number {
    const terminalRows = this.tui.terminal.rows || 30;
    return Math.max(6, Math.min(18, terminalRows - 12));
  }

  render(width: number): string[] {
    const border = this.theme.fg(
      "borderAccent",
      "─".repeat(Math.max(1, width)),
    );
    const snapshot = this.snapshot;
    const stage = this.stage;
    const stopping = this.isStopping();
    const stageLabel = stage
      ? `${stage.iteration}/${MAX_ITERATIONS} ${stage.stage}`
      : "starting";
    const status = stopping
      ? this.theme.fg("warning", "force stopping")
      : snapshot?.status === "error"
        ? this.theme.fg("error", "failed")
        : snapshot?.status === "done"
          ? this.theme.fg("success", "done")
          : this.theme.fg("warning", "running");
    const identity = snapshot
      ? ` · ${snapshot.id} · ${snapshot.backend}:${snapshot.meta.modelLabel ?? "?"} · ${formatElapsed(snapshot)}`
      : "";
    const header =
      this.theme.fg("accent", this.theme.bold("Review-fix loop")) +
      this.theme.fg("muted", ` · ${stageLabel}${identity} · `) +
      status;

    const height = this.bodyHeight();
    const transcript = snapshot
      ? buildTranscriptLines(snapshot, width, this.theme)
      : [];
    const maxOffset = Math.max(0, transcript.length - height);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(Math.max(0, end - height), end);
    const body =
      visible.length > 0
        ? [...visible]
        : [
            this.theme.fg(
              "dim",
              this.pollError
                ? `Unable to refresh live output: ${this.pollError}`
                : "Waiting for stage output...",
            ),
          ];
    if (snapshot?.errorText) {
      body.unshift(this.theme.fg("error", `Error: ${snapshot.errorText}`));
    }
    while (body.length < height) body.push("");

    const scrollHint =
      this.scrollOffset > 0 ? ` · ${this.scrollOffset} lines below` : "";
    const stopHint = stopping
      ? "Force stop requested; cancelling the active stage"
      : "Esc/Ctrl+C force stop now";
    const hints = this.theme.fg(
      "dim",
      `↑/↓ or PgUp/PgDn scroll${scrollHint} · ${stopHint}`,
    );

    return [
      border,
      truncateToWidth(header, width),
      border,
      ...body.slice(0, height),
      border,
      truncateToWidth(hints, width),
      border,
    ];
  }

  invalidate(): void {}

  dispose(): void {
    this.stopped = true;
    clearInterval(this.ticker);
  }
}

function outcomeText(outcome: ReviewFixLoopOutcome): string {
  const passSummary = `${outcome.fixPasses} completed fixer pass${outcome.fixPasses === 1 ? "" : "es"}`;
  switch (outcome.status) {
    case "clean":
      return `Review-fix loop converged after ${outcome.iterations} iteration${outcome.iterations === 1 ? "" : "s"} and ${passSummary}. Final review found no issues.`;
    case "max_iterations":
      return [
        `Review-fix loop reached the ${outcome.iterations}-iteration safety cap with ${passSummary}.`,
        "No clean review was obtained before the cap. The last review reported:",
        formatReviewOutput(outcome.finalReview),
        "Run /review-fix-loop again to review the current state.",
      ].join("\n\n");
    case "stopped":
      return `Review-fix loop force-stopped after ${outcome.iterations} completed iteration${outcome.iterations === 1 ? "" : "s"} and ${passSummary}. If a fixer was active, inspect the worktree for partial edits.`;
  }
}

async function ensureRepository(pi: ExtensionAPI, cwd: string): Promise<void> {
  const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeout: 10_000,
  });
  if (result.code !== 0 || result.stdout.trim() !== "true") {
    throw new Error("The current directory is not inside a Git worktree");
  }
}

const MAX_GIT_CONTEXT_CHARS = 120_000;

async function collectReviewContext(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string> {
  const [status, diff] = await Promise.all([
    pi.exec("git", ["status", "--short"], { cwd, timeout: 10_000 }),
    pi.exec("git", ["diff", "--no-ext-diff", "--unified=40", "HEAD", "--"], {
      cwd,
      timeout: 30_000,
    }),
  ]);
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || "git status failed");
  }
  if (diff.code !== 0) {
    throw new Error(diff.stderr.trim() || "git diff failed");
  }

  const context = [
    "$ git status --short",
    status.stdout.trim() || "(clean)",
    "",
    "$ git diff --no-ext-diff --unified=40 HEAD --",
    diff.stdout.trim() || "(no tracked diff)",
  ].join("\n");
  if (context.length <= MAX_GIT_CONTEXT_CHARS) return context;
  return `${context.slice(0, MAX_GIT_CONTEXT_CHARS)}\n\n[Captured diff truncated; inspect listed files directly.]`;
}

function parentContext(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): TrackedSubagentSpawnRequest["parent"] {
  return {
    parentCwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    inheritedModel: ctx.model
      ? { provider: ctx.model.provider, id: ctx.model.id }
      : undefined,
    inheritedThinkingLevel: pi.getThinkingLevel(),
    modelRegistry: ctx.modelRegistry,
  };
}

export default function reviewFixLoopExtension(pi: ExtensionAPI) {
  let activeLoop: ActiveLoop | undefined;
  let activeRunPromise: Promise<void> | undefined;
  let loopCounter = 0;
  let sessionContext: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
  });

  pi.on("session_shutdown", async () => {
    activeLoop?.forceStop?.();
    // This extension loads before the subagent host, so cancel and join the
    // active stage before the host is disposed.
    await activeRunPromise;
    activeRunPromise = undefined;
    activeLoop = undefined;
    sessionContext = undefined;
  });

  pi.on("session_before_switch", (_event, ctx) => {
    if (!activeLoop) return;
    ctx.ui.notify(
      "Stop the review-fix loop before replacing the session",
      "warning",
    );
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, ctx) => {
    if (!activeLoop) return;
    ctx.ui.notify(
      "Stop the review-fix loop before forking the session",
      "warning",
    );
    return { cancel: true };
  });

  // Keep the parent session quiescent while reviewers and fixers inspect and
  // mutate the same worktree. The TUI command also replaces the editor with a
  // read-only live monitor so extension commands cannot bypass this input gate.
  pi.on("input", (event, ctx) => {
    if (!activeLoop || event.source === "extension") return;
    ctx.ui.notify(
      "The review-fix loop owns the worktree until it finishes. Stop it before starting another agent turn.",
      "warning",
    );
    return { action: "handled" };
  });

  pi.on("tool_call", () => {
    if (!activeLoop) return;
    return {
      block: true,
      reason:
        "The parent review-fix loop is active; parent tool calls are blocked to prevent concurrent worktree access.",
    };
  });

  pi.on("user_bash", () => {
    if (!activeLoop) return;
    return {
      result: {
        output:
          "The review-fix loop is active. Stop it before running a shell command in the parent session.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.registerMessageRenderer(
    RESULT_MESSAGE_TYPE,
    (message, _options, theme) =>
      new Text(
        `${theme.fg("accent", theme.bold("Review-fix loop"))}\n${typeof message.content === "string" ? message.content : "Result unavailable"}`,
        0,
        0,
      ),
  );

  // Intentionally user-invoked only: keep this as a slash command and do not
  // expose an LLM tool or automatic lifecycle trigger for starting the loop.
  pi.registerCommand("review-fix-loop", {
    description:
      "Repeatedly review, independently verify, and fix current changes",
    handler: async (args, ctx) => {
      if (activeLoop) {
        ctx.ui.notify("A review-fix loop is already running", "warning");
        return;
      }
      if (ctx.mode === "rpc") {
        ctx.ui.notify(
          "The review-fix loop is unavailable in RPC mode because RPC commands cannot be given an exclusive worktree lock",
          "error",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the current agent turn to finish before starting a review-fix loop",
          "warning",
        );
        return;
      }

      try {
        await ensureRepository(pi, ctx.cwd);
        if (!ctx.modelRegistry.find("openai-codex", "gpt-5.6-sol")) {
          throw new Error(`Required model ${REVIEW_MODEL} is unavailable`);
        }
        const host = getTrackedSubagentHost(pi);
        if (!host) throw new Error("The subagents extension is unavailable");
        const conflicting = (await host.list()).filter(
          (snapshot) =>
            snapshot.status === "running" &&
            resolve(snapshot.cwd) === resolve(ctx.cwd),
        );
        if (conflicting.length > 0) {
          throw new Error(
            `Wait for running subagents in this worktree to finish: ${conflicting.map((snapshot) => snapshot.id).join(", ")}`,
          );
        }

        const loop: ActiveLoop = { id: ++loopCounter, stopRequested: false };
        const cancellingStages = new Set<string>();
        const cancelStage = (stage: LoopStageEvent | undefined) => {
          const id = stage?.snapshot.id;
          if (!id || cancellingStages.has(id)) return;
          cancellingStages.add(id);
          void host.cancel([id]).catch((error: unknown) => {
            cancellingStages.delete(id);
            const message =
              error instanceof Error ? error.message : String(error);
            sessionContext?.ui.notify(
              `Unable to cancel review-fix stage ${id}: ${message}`,
              "error",
            );
          });
        };
        loop.forceStop = () => {
          loop.stopRequested = true;
          cancelStage(loop.stage);
        };
        activeLoop = loop;
        const cwd = ctx.cwd;
        const parent = parentContext(pi, ctx);
        const instructions = args.trim();
        ctx.ui.setStatus("review-fix-loop", "starting");
        ctx.ui.notify(
          `Review-fix loop started (max ${MAX_ITERATIONS} iterations). In the TUI, press Esc to force stop the active stage.`,
          "info",
        );

        const running = runReviewFixLoop({
          host,
          cwd,
          parent,
          instructions,
          shouldStop: () => loop.stopRequested || activeLoop?.id !== loop.id,
          isParentIdle: () => sessionContext?.isIdle() ?? false,
          getReviewContext: () => collectReviewContext(pi, cwd),
          onStageStarted: (event) => {
            if (activeLoop?.id !== loop.id) return;
            loop.stage = event;
            if (loop.stopRequested) cancelStage(event);
            sessionContext?.ui.setStatus(
              "review-fix-loop",
              `${event.iteration}/${MAX_ITERATIONS} ${event.stage} (${event.snapshot.id})`,
            );
          },
        })
          .then(
            (outcome) => {
              if (activeLoop?.id !== loop.id) return;
              const content = outcomeText(outcome);
              pi.sendMessage(
                {
                  customType: RESULT_MESSAGE_TYPE,
                  content,
                  display: true,
                  details: outcome,
                },
                { deliverAs: "followUp", triggerTurn: false },
              );
            },
            (error) => {
              if (activeLoop?.id !== loop.id) return;
              const message =
                error instanceof Error ? error.message : String(error);
              pi.sendMessage(
                {
                  customType: RESULT_MESSAGE_TYPE,
                  content: `Review-fix loop failed: ${message}`,
                  display: true,
                  details: { status: "error", error: message },
                },
                { deliverAs: "followUp", triggerTurn: false },
              );
            },
          )
          .finally(() => {
            if (activeLoop?.id !== loop.id) return;
            activeLoop = undefined;
            activeRunPromise = undefined;
            sessionContext?.ui.setStatus("review-fix-loop", undefined);
          });
        activeRunPromise = running;
        if (ctx.mode === "tui") {
          await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
            const monitor = new ReviewFixLoopMonitor(
              tui,
              theme,
              keybindings,
              host,
              () => loop.stage,
              () => loop.stopRequested,
              () => {
                loop.forceStop?.();
                ctx.ui.setStatus("review-fix-loop", "force stopping");
              },
            );
            void running.finally(() => done(undefined));
            return monitor;
          });
        } else {
          // Print/JSON callers remain serialized until the loop emits its
          // final result, rather than racing another prompt against the fixer.
          await running;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.setStatus("review-fix-loop", undefined);
        ctx.ui.notify(`Review-fix loop failed: ${message}`, "error");
      }
    },
  });
}
