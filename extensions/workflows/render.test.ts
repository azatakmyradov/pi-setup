/**
 * Rendering tests for the `workflow` tool row and the /workflows dashboard.
 *
 * Both are driven through doubles: a plain-text themer (so assertions compare
 * visible text, not colors), a fake TUI, and fake keybindings. The dashboard
 * reads and writes the agent directory, so it is pointed at a temp dir before
 * the modules under test resolve any path.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-render-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const runsDir = path.join(agentDir, "workflows");

// keyHint (used by the collapsed-result expand hint) reads the global theme.
initTheme("dark", false);

const { WorkflowDashboard } = await import("./dashboard.ts");
const { default: workflows } = await import("./index.ts");
type WorkflowDetails = import("./model.ts").WorkflowDetails;
type AgentRecord = import("./model.ts").AgentRecord;

/** Plain-text themer: rows are asserted on their content, not their colors. */
// SAFETY: the renderers call only fg and bold on the theme they are handed.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replaceAll(ANSI, "");
const visible = (component: Component, width: number) =>
  component.render(width).map((line) => stripAnsi(line).trimEnd());

// --- Fixtures ------------------------------------------------------------------

function agent(
  overrides: Partial<AgentRecord> & Pick<AgentRecord, "index" | "label">,
): AgentRecord {
  return {
    phase: "Gather",
    state: "done",
    startedAt: 1_000,
    finishedAt: 4_000,
    preview: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    transcript: [],
    ...overrides,
  };
}

function details(overrides: Partial<WorkflowDetails> = {}): WorkflowDetails {
  return {
    runId: "wf_ab12cd34",
    sessionId: "session_fixture",
    name: "Release audit",
    description: "Audit the release",
    background: false,
    status: "completed",
    startedAt: 1_000,
    finishedAt: 4_000,
    phases: [{ title: "Gather" }],
    agents: [],
    ...overrides,
  };
}

// --- Tool renderers ------------------------------------------------------------

/** Only the members these tests drive, so the double can hold the whole tool. */
type RenderTool = Required<Pick<ToolDefinition, "name" | "renderCall" | "renderResult">>;

/** The renderer state the workflow tool shares between its two renderers. */
interface RenderState {
  details?: WorkflowDetails;
}

function workflowTool(): RenderTool {
  let registered: RenderTool | undefined;
  const pi: Partial<ExtensionAPI> = {
    on: () => () => {},
    registerCommand: () => {},
    registerTool: (definition) => {
      // SAFETY: the tests call only the two renderers, and both are defined.
      registered = definition as RenderTool;
    },
  };
  // SAFETY: registration touches only the three members above; anything else
  // is absent so a stray call throws instead of silently passing.
  workflows(pi as ExtensionAPI);
  if (!registered) throw new Error("workflow tool was not registered");
  return registered;
}

/** Structural stand-in for the unexported `ToolRenderContext`. */
function renderContext(state: RenderState) {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state,
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
}

/** Wide enough that the plain-text themer never triggers wrapping. */
const WIDE = 200;

function renderResultLines(tool: RenderTool, d: WorkflowDetails, isPartial = false): string[] {
  const component = tool.renderResult(
    { content: [{ type: "text", text: "ignored" }], details: d },
    { expanded: false, isPartial },
    theme,
    renderContext({}),
  );
  return visible(component, WIDE);
}

test("a background launch row points at the dashboard instead of freezing at 0/0", () => {
  const lines = renderResultLines(
    workflowTool(),
    details({ background: true, status: "running", finishedAt: undefined, agents: [] }),
  );

  assert.deepEqual(lines, [
    "● launched in background · wf_ab12cd34",
    "  ↳ /workflows to watch · result arrives as a follow-up message",
  ]);
});

test("the result header is a status line, without renderCall's `workflow <name>`", () => {
  const lines = renderResultLines(
    workflowTool(),
    details({
      status: "failed",
      agents: [
        agent({ index: 0, label: "first" }),
        agent({ index: 1, label: "second", state: "error", error: "boom" }),
      ],
    }),
  );

  assert.equal(lines[0], "✗ 2/2 agents · 3s · failed · 1 failed");
  assert.ok(!lines[0]?.includes("workflow"));
  assert.ok(!lines[0]?.includes("Release audit"));
});

test("the collapsed result leads with failures and caps the agent body", () => {
  const agents = [
    ...Array.from({ length: 12 }, (_, i) => agent({ index: i, label: `ok-${i}` })),
    agent({ index: 12, label: "flaky", state: "error", error: "boom\nstack line" }),
    agent({ index: 13, label: "live", state: "running", finishedAt: undefined }),
  ];
  const lines = renderResultLines(workflowTool(), details({ status: "failed", agents }));

  // Failure first (with its reason inline), then the live agent, then the rest.
  assert.equal(lines[1], "  ✗ flaky (Gather) · 3s — boom");
  assert.ok(lines[2]?.startsWith("  ● live"));
  assert.ok(lines[3]?.startsWith("  ✓ ok-0"));
  // 10 preview lines: 9 agents plus the truncation marker.
  assert.equal(lines[10], "…");
  assert.match(lines[11] ?? "", /expand/);
});

test("the call row carries the run id and summarizes phases past the preview limit", () => {
  const phases = Array.from({ length: 10 }, (_, i) => ({ title: `phase-${i}` }));
  const component = workflowTool().renderCall(
    {},
    theme,
    renderContext({ details: details({ phases }) }),
  );
  const lines = visible(component, WIDE);

  assert.equal(lines[0], "workflow Release audit · wf_ab12cd34");
  assert.equal(lines[1], "  Audit the release");
  assert.equal(lines.at(-1), "  …+2 more phases");
});

// --- Dashboard -----------------------------------------------------------------

const ENTER = "\r";

/** A real manager on stock defaults: the hints must reflect configured keys. */
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

// SAFETY: the dashboard reads terminal.rows and calls requestRender.
const tui = {
  terminal: { rows: 30 },
  requestRender: () => {},
} as TUI;

function dashboardFor(d: WorkflowDetails, initialRunId?: string) {
  // loadRunEntries only surfaces runs whose directory exists, live or not.
  fs.mkdirSync(path.join(runsDir, d.runId), { recursive: true });
  return new WorkflowDashboard(
    tui,
    theme,
    keybindings,
    () => new Map([[d.runId, d]]),
    d.sessionId ?? "session_fixture",
    new Set<string>(),
    () => {},
    initialRunId,
  );
}

function failingRun(): WorkflowDetails {
  return details({
    status: "failed",
    agents: [
      agent({ index: 0, label: "collect", state: "done" }),
      agent({ index: 1, label: "verify", state: "error", error: "assertion failed" }),
    ],
  });
}

test("the run list shows one row per run and the shared navigation hints", () => {
  const dashboard = dashboardFor(failingRun());
  try {
    const lines = dashboard.render(80).map(stripAnsi);

    assert.ok(lines[0]?.includes("Workflows"));
    assert.ok(lines.some((line) => line.includes("Release audit") && line.includes("wf_ab12cd34")));
    assert.ok(lines.some((line) => line.includes("2/2 agents") && line.includes("failed")));
    const hints = lines.at(-1) ?? "";
    assert.ok(hints.includes("up/down/jk select"), hints);
    assert.ok(hints.includes("g/G top/bottom"), hints);
  } finally {
    dashboard.dispose();
  }
});

test("the detail view keeps the run id visible and marks agent errors with a continuation", () => {
  const dashboard = dashboardFor(failingRun(), "wf_ab12cd34");
  try {
    const lines = dashboard.render(80).map(stripAnsi);

    assert.ok(lines[0]?.includes("Release audit"), lines[0]);
    assert.ok(lines[0]?.includes("wf_ab12cd34"), lines[0]);
    assert.ok(lines[1]?.includes("Audit the release"), lines[1]);
    assert.ok(
      lines.some((line) => line.includes("↳ assertion failed")),
      lines.join("\n"),
    );
  } finally {
    dashboard.dispose();
  }
});

test("a notice sits beside the hints instead of replacing them", () => {
  const dashboard = dashboardFor(failingRun(), "wf_ab12cd34");
  try {
    dashboard.handleInput("s");
    // Wide enough that neither column is truncated: both must be present.
    const hints = stripAnsi(dashboard.render(300).at(-1) ?? "");

    assert.ok(hints.includes("select phase"), hints);
    assert.ok(hints.includes("s save report"), hints);
    assert.ok(hints.includes("saved "), hints);
    assert.ok(fs.existsSync(path.join(runsDir, "wf_ab12cd34", "report.md")));
  } finally {
    dashboard.dispose();
  }
});

test("the transcript view sanitizes child output, times tools, and caches its rows", () => {
  const run = failingRun();
  const subject = run.agents[0]!;
  subject.transcript = [
    { role: "tool", name: "bash", text: "\u001b[31mred\u001b[39m\tcolumn", durationMs: 4_200 },
  ];
  const dashboard = dashboardFor(run, "wf_ab12cd34");
  try {
    dashboard.handleInput("l"); // phases -> agents
    dashboard.handleInput(ENTER); // agents -> transcript
    const first = dashboard.render(80).map(stripAnsi).join("\n");

    assert.ok(first.includes("TOOL bash · 4.2s"), first);
    // ANSI stripped and the tab expanded to two spaces before wrapping.
    assert.ok(first.includes("red  column"), first);

    // Rows are memoized on the entry count and the last entry's text length,
    // so a repaint with nothing changed reuses them...
    assert.equal(dashboard.render(80).join("\n"), dashboard.render(80).join("\n"));

    // ...a streaming last entry that grows without adding an entry rebuilds...
    subject.transcript[0]!.text = "rewritten and now much longer";
    assert.ok(
      dashboard.render(80).map(stripAnsi).join("\n").includes("rewritten and now much longer"),
    );

    // ...and so does an appended entry.
    subject.transcript.push({ role: "assistant", text: "done here" });
    const grown = dashboard.render(80).map(stripAnsi).join("\n");
    assert.ok(grown.includes("rewritten and now much longer"), grown);
    assert.ok(grown.includes("done here"), grown);
  } finally {
    dashboard.dispose();
  }
});
