import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import { CHAT_ROW_INVALIDATE_MS, SubagentChatRow } from "./src/ui/chat-row.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

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

  assert.match(row.render(120)[0] ?? "", /Claude Subagent.*Starting/);

  row.markStarted();
  const restored = row.render(120)[0] ?? "";
  assert.match(restored, /Claude Subagent.*Started/);
  assert.doesNotMatch(restored, /Background/);
});

test("renders the latest running tool activity", () => {
  const view = new TestView(
    snapshot({
      backend: "claude",
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
  const row = new SubagentChatRow("claude", "Map extension architecture", theme);
  row.connect(view, "sa-1", () => {});

  assert.deepEqual(row.render(120), [
    "⠋ Claude Subagent — Map extension architecture  Background",
    "  ↳ Read extensions/subagents/index.ts",
  ]);
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
    /^✓ Pi Subagent — Map project infrastructure  Done · 18s$/,
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

  assert.equal(row.render(120)[0], "✗ Codex Subagent — Map runtime integration  Failed · 7s");
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
  });
  view.emit();

  assert.equal(row.render(120)[0], "✗ Pi Subagent — Inspect tests  Cancelled · 3s");
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
