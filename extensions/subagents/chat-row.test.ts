import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import { CHAT_ROW_INVALIDATE_MS, SubagentChatRow, type ChatRowTheme } from "./src/ui/chat-row.ts";

/**
 * Plain-text themer: rows are asserted on their content, not their colors.
 * Strikethrough is the one style that carries meaning (denied vs failed), so
 * it is marked with `~` instead of being dropped.
 */
const theme: ChatRowTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => `~${text}~`,
};

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "Map extension architecture",
    prompt: "Map the extension architecture",
    cwd: "/tmp/project",
    status: "running",
    createdAt: 1_000,
    meta: { backend: "pi", modelLabel: "test-model" },
    usage: {},
    compacting: false,
    compactionCount: 0,
    cancelled: false,
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

class TestView {
  current: SubagentSnapshot | undefined;
  readonly listeners = new Set<() => void>();
  unsubscribeCount = 0;

  constructor(current: SubagentSnapshot | undefined) {
    this.current = current;
  }

  get(id: string): SubagentSnapshot | undefined {
    return this.current?.id === id ? this.current : undefined;
  }

  subscribeTo(id: string, listener: () => void): () => void {
    assert.equal(id, this.current?.id);
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) this.unsubscribeCount++;
    };
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("renders starting and restored states without claiming background work", () => {
  const row = new SubagentChatRow("claude", "Map extension architecture", theme);

  // Not connected yet, so there is no id to show — just the status label.
  assert.equal(row.render(120)[0], "⠋ Claude Subagent — Map extension architecture  Starting");

  row.markStarted();
  const restored = row.render(120)[0] ?? "";
  assert.equal(restored, "○ Claude Subagent — Map extension architecture  Started");
  assert.doesNotMatch(restored, /Background/);
});

function runningToolView() {
  return new TestView(
    snapshot({
      backend: "claude",
      createdAt: Date.now(),
      meta: { backend: "claude" },
      liveTools: [
        {
          toolId: "tool-1",
          name: "read",
          argsPreview: '{"path":"extensions/subagents/index.ts"}',
        },
      ],
    }),
  );
}

test("renders the latest running tool activity", () => {
  const view = runningToolView();
  const row = new SubagentChatRow("claude", "Map extension architecture", theme);
  // A blocking spawn is waiting for this child, so the row says "Running".
  row.connect(view, "sa-1", () => {});

  assert.deepEqual(row.render(120), [
    "⠋ Claude Subagent — Map extension architecture  sa-1 · Running · 0s",
    "  ↳ Read extensions/subagents/index.ts",
  ]);
  row.dispose();
});

test("labels a background spawn as Background", () => {
  const view = runningToolView();
  const row = new SubagentChatRow("claude", "Map extension architecture", theme);
  row.update("claude", "Map extension architecture", theme, true);
  row.connect(view, "sa-1", () => {});

  assert.deepEqual(row.render(120), [
    "⠋ Claude Subagent — Map extension architecture  sa-1 · Background · 0s",
    "  ↳ Read extensions/subagents/index.ts",
  ]);
  row.dispose();
});

test("a detached blocking spawn keeps the Background label", () => {
  const view = runningToolView();
  const row = new SubagentChatRow("claude", "Map extension architecture", theme);
  row.connect(view, "sa-1", () => {});
  row.markDetached();

  assert.match(row.render(120)[0] ?? "", /sa-1 · Background · 0s/);

  // Streaming args keep calling update; the detach must stick.
  row.update("claude", "Map extension architecture", theme, false);
  assert.match(row.render(120)[0] ?? "", /sa-1 · Background · 0s/);
  row.dispose();
});

test("retains fast tool activity until the subagent settles", () => {
  const view = new TestView(snapshot());
  const row = new SubagentChatRow("pi", "Inspect updates", theme);
  row.connect(view, "sa-1", () => {});

  view.current = snapshot({
    liveTools: [
      {
        toolId: "tool-1",
        name: "bash",
        argsPreview: '{"command":"npm test"}',
      },
    ],
  });
  view.emit();
  view.current = snapshot({ liveTools: [] });
  view.emit();

  assert.equal(row.render(120)[1], "  ↳ Bash npm test");

  view.current = snapshot({
    liveTools: [
      {
        toolId: "tool-2",
        name: "read",
        argsPreview: '{"path":"package.json"}',
      },
    ],
  });
  view.emit();
  assert.equal(row.render(120)[1], "  ↳ Read package.json");

  view.current = snapshot({ status: "done", settledAt: 2_000 });
  view.emit();
  assert.equal(row.render(120).length, 1);
  row.dispose();
});

test("renders successful settlement with elapsed time", () => {
  const view = new TestView(snapshot());
  const row = new SubagentChatRow("pi", "Map project infrastructure", theme);
  row.connect(view, "sa-1", () => {});

  view.current = snapshot({
    status: "done",
    settledAt: 19_000,
    finalText: "done",
  });
  view.emit();

  assert.match(
    row.render(120)[0] ?? "",
    /^✓ Pi Subagent — Map project infrastructure  sa-1 · Done · 18s$/,
  );
  assert.equal(view.listeners.size, 0);
  row.dispose();
});

test("renders failed settlement", () => {
  const view = new TestView(snapshot());
  const row = new SubagentChatRow("codex", "Map runtime integration", theme);
  row.connect(view, "sa-1", () => {});

  view.current = snapshot({
    backend: "codex",
    meta: { backend: "codex" },
    status: "error",
    settledAt: 8_000,
    errorText: "Backend failed",
  });
  view.emit();

  assert.equal(
    row.render(120)[0],
    "✗ Codex Subagent — Map runtime integration  sa-1 · Failed · 7s",
  );
  row.dispose();
});

test("renders interrupted settlement as cancelled", () => {
  const view = new TestView(snapshot());
  const row = new SubagentChatRow("pi", "Inspect tests", theme);
  row.connect(view, "sa-1", () => {});

  view.current = snapshot({
    status: "error",
    settledAt: 4_000,
    errorText: "Run was aborted",
    cancelled: true,
  });
  view.emit();

  // Cancelled is a denial: neutral glyph and a struck-through label, no red ✗.
  assert.equal(row.render(120)[0], "○ Pi Subagent — Inspect tests  sa-1 · ~Cancelled~ · 3s");
  row.dispose();
});

test("truncates every rendered line to the available width", () => {
  const view = new TestView(
    snapshot({
      liveTools: [
        {
          toolId: "tool-1",
          name: "read",
          argsPreview: JSON.stringify({ path: "a/very/long/path/to/a/source/file.ts" }),
        },
      ],
    }),
  );
  const row = new SubagentChatRow("pi", "A title that is much wider than the terminal", theme);
  row.connect(view, "sa-1", () => {});

  const lines = row.render(24);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.ok(lines.some((line) => line.includes("…")));
  row.dispose();
});

test("animates the standard Pi working spinner", async () => {
  let invalidations = 0;
  const row = new SubagentChatRow("pi", "Inspect updates", theme);
  row.setRequestInvalidate(() => invalidations++);
  const first = row.render(120)[0];

  await delay(100);

  assert.notEqual(row.render(120)[0], first);
  assert.ok(invalidations >= 1);
  row.dispose();
});

test("debounces live snapshot invalidation", async () => {
  const view = new TestView(snapshot());
  let invalidations = 0;
  const row = new SubagentChatRow("pi", "Inspect updates", theme);
  row.connect(view, "sa-1", () => invalidations++);

  view.emit();
  view.emit();
  view.emit();
  row.markStarted();
  assert.equal(invalidations, 0);

  await delay(CHAT_ROW_INVALIDATE_MS + 30);
  assert.equal(invalidations, 1);
  row.dispose();
});

test("cleans up its subscription and pending invalidation on dispose", async () => {
  const view = new TestView(snapshot());
  const activity: boolean[] = [];
  let invalidations = 0;
  const row = new SubagentChatRow("pi", "Inspect cleanup", theme, {
    onSubscriptionChange: (_row, active) => activity.push(active),
  });
  row.connect(view, "sa-1", () => invalidations++);
  view.emit();

  row.dispose();
  assert.equal(view.listeners.size, 0);
  assert.equal(view.unsubscribeCount, 1);
  assert.deepEqual(activity, [true, false]);

  await delay(CHAT_ROW_INVALIDATE_MS + 30);
  assert.equal(invalidations, 0);
});

test("renders a queued subagent with the pending glyph", () => {
  const view = new TestView(
    snapshot({
      status: "queued",
      title: "Check pi-tui API",
      createdAt: Date.now(),
    }),
  );
  const row = new SubagentChatRow("pi", "Check pi-tui API", theme);
  row.connect(view, "sa-1", () => {});

  // Static glyph, not the spinner: nothing is running yet.
  assert.deepEqual(row.render(120), ["○ Pi Subagent — Check pi-tui API  sa-1 · Queued · 0s"]);
  row.dispose();
});

test("keeps its subscription while queued and repaints when it starts", async () => {
  const view = new TestView(snapshot({ status: "queued", createdAt: Date.now() }));
  let invalidations = 0;
  const row = new SubagentChatRow("pi", "Inspect updates", theme);
  try {
    row.connect(view, "sa-1", () => invalidations++);

    // Unsubscribing here would freeze the row at "Queued" forever.
    assert.equal(view.listeners.size, 1);
    assert.match(row.render(120)[0] ?? "", /Queued/);

    view.current = snapshot({ status: "running", createdAt: Date.now() });
    view.emit();
    await delay(CHAT_ROW_INVALIDATE_MS + 30);

    assert.ok(invalidations >= 1);
    assert.doesNotMatch(row.render(120)[0] ?? "", /Queued/);
  } finally {
    row.dispose();
  }
});
