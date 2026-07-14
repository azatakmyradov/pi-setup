import { readFileSync } from "node:fs";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { extractJson } from "../shared/subagent.ts";
import { getTrackedSubagentHost } from "../shared/tracked-subagent.ts";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";

const REVIEW_RUBRIC = readFileSync(new URL("./rubric.md", import.meta.url), "utf8").trim();
const REVIEW_MESSAGE_TYPE = "code-review-result";
const MAX_VISIBLE_ITEMS = 10;
const REVIEW_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

type ReviewPreset = "base" | "uncommitted" | "commit" | "custom";

type ReviewTarget =
  | { type: "base"; branch: string; mergeBase?: string }
  | { type: "uncommitted" }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

interface CommitEntry {
  sha: string;
  title: string;
}

export interface ReviewFinding {
  title: string;
  body: string;
  confidence_score: number;
  priority?: number | null;
  code_location: {
    absolute_file_path: string;
    line_range: { start: number; end: number };
  };
}

export interface ReviewOutput {
  findings: ReviewFinding[];
  overall_correctness: "patch is correct" | "patch is incorrect";
  overall_explanation: string;
  overall_confidence_score: number;
}

interface PickerItem {
  id: string;
  label: string;
  searchText: string;
}

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          confidence_score: { type: "number", minimum: 0, maximum: 1 },
          priority: { type: ["integer", "null"], minimum: 0, maximum: 3 },
          code_location: {
            type: "object",
            properties: {
              absolute_file_path: { type: "string" },
              line_range: {
                type: "object",
                properties: {
                  start: { type: "integer", minimum: 1 },
                  end: { type: "integer", minimum: 1 },
                },
                required: ["start", "end"],
                additionalProperties: false,
              },
            },
            required: ["absolute_file_path", "line_range"],
            additionalProperties: false,
          },
        },
        required: ["title", "body", "confidence_score", "code_location"],
        additionalProperties: false,
      },
    },
    overall_correctness: { type: "string", enum: ["patch is correct", "patch is incorrect"] },
    overall_explanation: { type: "string" },
    overall_confidence_score: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"],
  additionalProperties: false,
};

class SearchPicker implements Component, Focusable {
  private readonly input = new Input();
  private filtered: PickerItem[];
  private selectedIndex = 0;
  private _focused = false;

  constructor(
    private readonly title: string,
    private readonly placeholder: string,
    private readonly items: PickerItem[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (value: string | null) => void,
  ) {
    this.filtered = items;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private filter(): void {
    const terms = this.input.getValue().trim().toLowerCase().split(/\s+/).filter(Boolean);
    this.filtered = terms.length === 0
      ? this.items
      : this.items.filter((item) => {
          const haystack = item.searchText.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE_ITEMS);
    } else if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + MAX_VISIBLE_ITEMS);
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done(selected.id);
      return;
    } else {
      this.input.handleInput(data);
      this.filter();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const lines = [
      this.theme.fg("accent", "─".repeat(renderWidth)),
      truncateToWidth(` ${this.theme.bold(this.title)}`, renderWidth, "…"),
      "",
    ];

    if (!this.input.getValue()) {
      lines.push(truncateToWidth(` ${this.theme.fg("dim", this.placeholder)}`, renderWidth, "…"));
    }
    lines.push(...this.input.render(renderWidth), "");

    if (this.filtered.length === 0) {
      lines.push(this.theme.fg("warning", "  No matches"));
    } else {
      const start = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(MAX_VISIBLE_ITEMS / 2),
          this.filtered.length - MAX_VISIBLE_ITEMS,
        ),
      );
      const end = Math.min(start + MAX_VISIBLE_ITEMS, this.filtered.length);
      for (let index = start; index < end; index++) {
        const item = this.filtered[index]!;
        const selected = index === this.selectedIndex;
        const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
        const label = selected ? this.theme.fg("accent", item.label) : item.label;
        lines.push(truncateToWidth(prefix + label, renderWidth, "…"));
      }
      if (start > 0 || end < this.filtered.length) {
        lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filtered.length})`));
      }
    }

    lines.push(
      "",
      truncateToWidth(
        ` ${this.theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc back")}`,
        renderWidth,
        "…",
      ),
      this.theme.fg("accent", "─".repeat(renderWidth)),
    );
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

export function isReviewOutput(value: unknown): value is ReviewOutput {
  if (!value || typeof value !== "object") return false;
  const output = value as Partial<ReviewOutput>;
  const findingsAreValid = Array.isArray(output.findings) && output.findings.every((finding) => {
    if (!finding || typeof finding !== "object") return false;
    const candidate = finding as Partial<ReviewFinding>;
    const location = candidate.code_location;
    const range = location?.line_range;
    return (
      typeof candidate.title === "string" &&
      typeof candidate.body === "string" &&
      typeof candidate.confidence_score === "number" &&
      !!location &&
      typeof location.absolute_file_path === "string" &&
      !!range &&
      Number.isInteger(range.start) &&
      Number.isInteger(range.end)
    );
  });
  return (
    findingsAreValid &&
    (output.overall_correctness === "patch is correct" || output.overall_correctness === "patch is incorrect") &&
    typeof output.overall_explanation === "string" &&
    typeof output.overall_confidence_score === "number"
  );
}

export function formatReviewOutput(output: ReviewOutput): string {
  const sections: string[] = [];
  const explanation = output.overall_explanation.trim();
  if (explanation) sections.push(explanation);

  if (output.findings.length > 0) {
    const lines = [output.findings.length === 1 ? "Review comment:" : "Full review comments:"];
    for (const finding of output.findings) {
      const { absolute_file_path: path, line_range: range } = finding.code_location;
      lines.push("", `- ${finding.title} — ${path}:${range.start}-${range.end}`, `  ${finding.body}`);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n") || "No findings.";
}

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  options: { optional?: boolean; signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const result = await pi.exec("git", args, { cwd, timeout: 10_000, signal: options.signal });
  if (result.code === 0) return result.stdout.trim();
  if (options.optional) return undefined;
  throw new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
}

async function ensureRepository(pi: ExtensionAPI, cwd: string): Promise<void> {
  const inside = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], { optional: true });
  if (inside !== "true") throw new Error("The current directory is not inside a Git worktree");
}

async function localBranches(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const output = await git(
    pi,
    cwd,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
  );
  const branches = (output ?? "").split("\n").map((branch) => branch.trim()).filter(Boolean).sort();
  const remoteHead = await git(
    pi,
    cwd,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { optional: true },
  );
  const defaultBranch = remoteHead?.replace(/^origin\//, "");
  const defaultIndex = defaultBranch ? branches.indexOf(defaultBranch) : -1;
  if (defaultIndex > 0) branches.unshift(branches.splice(defaultIndex, 1)[0]!);
  return branches;
}

async function recentCommits(pi: ExtensionAPI, cwd: string): Promise<CommitEntry[]> {
  const output = await git(
    pi,
    cwd,
    ["log", "-n", "100", "--pretty=format:%H%x1f%s"],
  );
  return (output ?? "").split("\n").flatMap((line) => {
    const separator = line.indexOf("\x1f");
    if (separator < 1) return [];
    return [{ sha: line.slice(0, separator), title: line.slice(separator + 1).trim() }];
  });
}

async function mergeBase(pi: ExtensionAPI, cwd: string, branch: string): Promise<string | undefined> {
  let comparisonRef = branch;
  const upstream = await git(
    pi,
    cwd,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
    { optional: true },
  );
  if (upstream) {
    const counts = await git(pi, cwd, ["rev-list", "--left-right", "--count", `${branch}...${upstream}`], {
      optional: true,
    });
    const remoteAhead = Number(counts?.trim().split(/\s+/)[1] ?? 0);
    if (remoteAhead > 0) comparisonRef = upstream;
  }
  return git(pi, cwd, ["merge-base", "HEAD", comparisonRef], { optional: true });
}

function targetPrompt(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";
    case "base":
      return target.mergeBase
        ? `Review the code changes against the base branch '${target.branch}'. The merge base commit for this comparison is ${target.mergeBase}. Run \`git diff ${target.mergeBase}\` to inspect the changes relative to ${target.branch}. Provide prioritized, actionable findings.`
        : `Review the code changes against the base branch '${target.branch}'. Find the merge base between HEAD and ${target.branch}, inspect that diff, and provide prioritized, actionable findings.`;
    case "commit":
      return target.title
        ? `Review the code changes introduced by commit ${target.sha} ("${target.title}"). Provide prioritized, actionable findings.`
        : `Review the code changes introduced by commit ${target.sha}. Provide prioritized, actionable findings.`;
    case "custom":
      return target.instructions;
  }
}

function reviewHint(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "current changes";
    case "base":
      return `changes against '${target.branch}'`;
    case "commit":
      return target.title ? `commit ${target.sha.slice(0, 7)}: ${target.title}` : `commit ${target.sha.slice(0, 7)}`;
    case "custom":
      return target.instructions;
  }
}

async function selectPreset(ctx: ExtensionCommandContext): Promise<ReviewPreset | null> {
  const items: SelectItem[] = [
    { value: "base", label: "Review against a base branch", description: "(PR Style)" },
    { value: "uncommitted", label: "Review uncommitted changes" },
    { value: "commit", label: "Review a commit" },
    { value: "custom", label: "Custom review instructions" },
  ];

  if (ctx.mode !== "tui") {
    if (!ctx.hasUI) return "uncommitted";
    const selected = await ctx.ui.select("Select a review preset", items.map((item) => item.label));
    const index = selected ? items.findIndex((item) => item.label === selected) : -1;
    return index >= 0 ? items[index]!.value as ReviewPreset : null;
  }

  return ctx.ui.custom<ReviewPreset | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset")), 1, 1));
    const list = new SelectList(items, items.length, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value as ReviewPreset);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 1));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function selectSearchable(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
  items: PickerItem[],
): Promise<string | null> {
  if (items.length === 0) return null;
  if (ctx.mode !== "tui") {
    if (!ctx.hasUI) return items[0]!.id;
    const selected = await ctx.ui.select(title, items.map((item) => item.label));
    return items.find((item) => item.label === selected)?.id ?? null;
  }
  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) =>
    new SearchPicker(title, placeholder, items, tui, theme, done));
}

async function chooseTarget(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  directInstructions: string,
): Promise<ReviewTarget | null> {
  if (directInstructions) return { type: "custom", instructions: directInstructions };

  while (true) {
    const preset = await selectPreset(ctx);
    if (!preset) return null;
    if (preset === "uncommitted") return { type: "uncommitted" };

    if (preset === "custom") {
      const instructions = await ctx.ui.input(
        "Custom review instructions",
        "Type instructions and press Enter",
      );
      if (instructions?.trim()) return { type: "custom", instructions: instructions.trim() };
      if (!ctx.hasUI) return null;
      continue;
    }

    if (preset === "base") {
      const branches = await localBranches(pi, ctx.cwd);
      if (branches.length === 0) {
        ctx.ui.notify("No local branches found", "warning");
        continue;
      }
      const current = await git(pi, ctx.cwd, ["branch", "--show-current"], { optional: true }) || "(detached HEAD)";
      const branch = await selectSearchable(
        ctx,
        "Select a base branch",
        "Type to search branches",
        branches.map((name) => ({ id: name, label: `${current} → ${name}`, searchText: name })),
      );
      if (!branch) continue;
      return { type: "base", branch, mergeBase: await mergeBase(pi, ctx.cwd, branch) };
    }

    const commits = await recentCommits(pi, ctx.cwd);
    if (commits.length === 0) {
      ctx.ui.notify("No commits found", "warning");
      continue;
    }
    const sha = await selectSearchable(
      ctx,
      "Select a commit to review",
      "Type to search commits",
      commits.map((commit) => ({
        id: commit.sha,
        label: commit.title || commit.sha.slice(0, 12),
        searchText: `${commit.title} ${commit.sha}`,
      })),
    );
    if (!sha) continue;
    const commit = commits.find((entry) => entry.sha === sha);
    return { type: "commit", sha, title: commit?.title };
  }
}

export function appendReviewSchemaInstruction(prompt: string): string {
  return [
    prompt,
    "",
    "---",
    "Respond with ONLY one JSON object matching this JSON schema, with no prose before or after it.",
    `Schema: ${JSON.stringify(REVIEW_SCHEMA)}`,
  ].join("\n");
}

export function parseReviewOutput(text: string): ReviewOutput {
  const output = extractJson(text);
  if (!isReviewOutput(output)) {
    throw new Error("Reviewer returned an invalid structured result");
  }
  return output;
}

function reviewPrompt(target: ReviewTarget): string {
  return appendReviewSchemaInstruction(
    `${REVIEW_RUBRIC}\n\n---\n\n## Review task\n\n${targetPrompt(target)}`,
  );
}

type ReviewResultSnapshot = Pick<
  SubagentSnapshot,
  "id" | "status" | "finalText" | "errorText"
>;

function deliverReviewResult(pi: ExtensionAPI, snapshot: ReviewResultSnapshot): void {
  let content: string;
  let details: unknown;

  if (snapshot.status === "done") {
    try {
      const output = parseReviewOutput(snapshot.finalText);
      content = formatReviewOutput(output);
      details = output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      content = `Review ${snapshot.id} failed: ${message}. Use /subagents to inspect the reviewer transcript.`;
      details = { id: snapshot.id, status: snapshot.status, error: message };
    }
  } else {
    const message = snapshot.errorText ?? "Reviewer stopped without a result";
    content = `Review ${snapshot.id} failed: ${message}. Use /subagents to inspect the reviewer transcript.`;
    details = { id: snapshot.id, status: snapshot.status, error: message };
  }

  pi.sendMessage(
    {
      customType: REVIEW_MESSAGE_TYPE,
      content,
      display: true,
      details,
    },
    { triggerTurn: false },
  );
}

export function createReviewResultDelivery(
  pi: ExtensionAPI,
  isParentIdle: () => boolean,
) {
  const pending = new Map<string, ReviewResultSnapshot>();

  const flush = () => {
    if (!isParentIdle()) return;
    for (const snapshot of pending.values()) {
      pending.delete(snapshot.id);
      deliverReviewResult(pi, snapshot);
    }
  };

  return {
    settle(snapshot: SubagentSnapshot, consumed: boolean) {
      if (consumed) {
        pending.delete(snapshot.id);
        return;
      }
      pending.set(snapshot.id, {
        id: snapshot.id,
        status: snapshot.status,
        finalText: snapshot.finalText,
        errorText: snapshot.errorText,
      });
      flush();
    },
    flush,
    clear() {
      pending.clear();
    },
  };
}

interface StartedReview {
  readonly snapshot: SubagentSnapshot;
  readonly completion: Promise<void>;
}

async function startReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  target: ReviewTarget,
  onSettled: (snapshot: SubagentSnapshot, consumed: boolean) => void,
): Promise<StartedReview> {
  const host = getTrackedSubagentHost(pi);
  if (!host) {
    throw new Error("The subagents extension is unavailable");
  }
  if (!ctx.model) throw new Error("No model selected");

  let finish: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const snapshot = await host.spawn({
    backend: "pi",
    prompt: reviewPrompt(target),
    title: `review: ${reviewHint(target)}`.slice(0, 160),
    cwd: ctx.cwd,
    tools: REVIEW_TOOLS,
    parent: {
      parentCwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      inheritedModel: { provider: ctx.model.provider, id: ctx.model.id },
      inheritedThinkingLevel: pi.getThinkingLevel(),
      modelRegistry: ctx.modelRegistry,
    },
    onSettled(settled, consumed) {
      try {
        onSettled(settled, consumed);
        return true;
      } finally {
        finish?.();
      }
    },
  });
  return { snapshot, completion };
}

export default function reviewExtension(pi: ExtensionAPI) {
  let sessionContext: ExtensionContext | undefined;
  const resultDelivery = createReviewResultDelivery(
    pi,
    () => sessionContext?.isIdle() ?? false,
  );

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
  });
  pi.on("agent_settled", resultDelivery.flush);
  pi.on("session_shutdown", () => {
    sessionContext = undefined;
    resultDelivery.clear();
  });

  pi.registerMessageRenderer(REVIEW_MESSAGE_TYPE, (message, _options, theme) => {
    const output = message.details;
    if (!isReviewOutput(output)) {
      return new Text(typeof message.content === "string" ? message.content : "Review result unavailable", 0, 0);
    }
    const heading = output.findings.length === 0
      ? theme.fg("success", theme.bold("Review complete — no findings"))
      : theme.fg("warning", theme.bold(`Review complete — ${output.findings.length} finding${output.findings.length === 1 ? "" : "s"}`));
    const body = formatReviewOutput(output);
    return new Text(`${heading}\n${theme.fg("muted", output.overall_correctness)}\n\n${body}`, 0, 0);
  });

  pi.registerCommand("review", {
    description: "Review my current changes and find issues",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current agent turn to finish before starting a review", "warning");
        return;
      }

      try {
        await ensureRepository(pi, ctx.cwd);
        const target = await chooseTarget(pi, ctx, args.trim());
        if (!target) return;

        const review = await startReview(pi, ctx, target, resultDelivery.settle);
        ctx.ui.notify(
          `Review ${review.snapshot.id} started in the background. Use /subagents to inspect or cancel it.`,
          "info",
        );
        // Print/JSON sessions shut down as soon as the command returns, so
        // keep them alive long enough to emit the structured review result.
        if (!ctx.hasUI) await review.completion;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Review failed: ${message}`, "error");
      }
    },
  });
}
