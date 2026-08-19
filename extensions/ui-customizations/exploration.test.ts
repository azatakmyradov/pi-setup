import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
  clearExplorationRenderer,
  classifyExplorationTool,
  ExplorationTracker,
  type ExplorationItem,
  formatExplorationCounts,
  installExplorationClickHandler,
  installExplorationRenderer,
  renderExplorationGroup,
} from "./exploration.ts";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const identityStyles = {
  active: (text: string) => text,
  muted: (text: string) => text,
  error: (text: string) => text,
};

type MockTUI = TUI & {
  openUrl: (url: string, ...args: unknown[]) => unknown;
  requestRender: () => void;
  mode: string;
};

test("classifies exploration tools", () => {
  assert.equal(classifyExplorationTool("read"), "read");
  assert.equal(classifyExplorationTool("fffind"), "search");
  assert.equal(classifyExplorationTool("ffgrep"), "search");
  assert.equal(classifyExplorationTool("find"), undefined);
  assert.equal(classifyExplorationTool("grep"), undefined);
  assert.equal(classifyExplorationTool("bash"), undefined);
});

test("formats exploration counts with exact singular/plural forms", () => {
  const items: ExplorationItem[] = [
    { toolCallId: "r1", toolName: "read", args: {}, status: "running" },
    { toolCallId: "f1", toolName: "fffind", args: {}, status: "running" },
    { toolCallId: "g1", toolName: "ffgrep", args: {}, status: "running", matchCount: 17 },
  ];
  assert.equal(formatExplorationCounts(items), "1 read, 2 searches");
  assert.equal(formatExplorationCounts(items.slice(0, 1)), "1 read");
  assert.equal(
    formatExplorationCounts([
      { toolCallId: "r1", toolName: "read", args: {}, status: "running" },
      { toolCallId: "r2", toolName: "read", args: {}, status: "running" },
      { toolCallId: "s1", toolName: "fffind", args: {}, status: "running" },
    ]),
    "2 reads, 1 search",
  );
});

test("tracks cumulative assistant tool calls as one group and keeps it across a start-only exploration turn", () => {
  const tracker = new ExplorationTracker();
  const initialMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } },
      { type: "toolCall", id: "f1", name: "fffind", arguments: { pattern: "TODO", path: "src" } },
    ],
  } as const;

  tracker.handleMessageUpdate(initialMessage as unknown, { type: "start" } as const);
  tracker.handleMessageUpdate(initialMessage as unknown, { type: "toolcall_delta" } as const);
  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "g1",
          name: "ffgrep",
          arguments: { pattern: "FIXME", path: "src" },
        },
      ],
    } as const,
    { type: "start" } as const,
  );

  const group = tracker.groupForTool("r1");
  assert.ok(group);
  assert.equal(group, tracker.groupForTool("f1"));
  assert.equal(group, tracker.groupForTool("g1"));
  assert.deepEqual(group!.items.map((item) => item.toolCallId), ["r1", "f1", "g1"]);
});

test("splits groups on assistant text/thinking and non-exploration calls", () => {
  const tracker = new ExplorationTracker();

  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } }],
    } as const,
    { type: "start" } as const,
  );

  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [
        { type: "text", text: "step" },
        { type: "thinking", thinking: "compute" },
        { type: "toolCall", id: "shell", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "r2", name: "read", arguments: { path: "src/b.ts" } },
      ],
    } as const,
    { type: "toolcall_delta" } as const,
  );

  const firstGroup = tracker.groupForTool("r1");
  const secondGroup = tracker.groupForTool("r2");
  assert.ok(firstGroup);
  assert.ok(secondGroup);
  assert.notEqual(firstGroup.id, secondGroup.id);
  assert.deepEqual(firstGroup.items.map((item) => item.toolCallId), ["r1"]);
  assert.deepEqual(secondGroup.items.map((item) => item.toolCallId), ["r2"]);
  assert.equal(firstGroup.active, false);
});

test("interleaved tool lifecycle events do not reseal a later source-order group", () => {
  const tracker = new ExplorationTracker();
  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "shell", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "r2", name: "read", arguments: { path: "b.ts" } },
      ],
    },
    { type: "start" },
  );

  const laterGroup = tracker.groupForTool("r2");
  assert.ok(laterGroup);
  assert.notEqual(tracker.groupForTool("r1"), laterGroup);

  tracker.toolExecutionStart("r1", "read", { path: "a.ts" });
  tracker.toolExecutionStart("shell", "bash", { command: "ls" });
  tracker.toolExecutionStart("r2", "read", { path: "b.ts" });
  tracker.toolExecutionUpdate("shell", "bash", { command: "ls" });

  assert.equal(laterGroup.active, true);
});

test("does not reseal a tool group when cumulative updates repeat the boundary", () => {
  const tracker = new ExplorationTracker();
  const cumulativeBoundary = {
    role: "assistant",
    content: [
      { type: "text", text: "processing" },
      { type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } },
    ],
  } as const;

  tracker.handleMessageUpdate(cumulativeBoundary as unknown, { type: "start" } as const);
  tracker.handleMessageUpdate(cumulativeBoundary as unknown, { type: "toolcall_delta" } as const);
  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [
        ...cumulativeBoundary.content,
        { type: "toolCall", id: "r2", name: "read", arguments: { path: "src/b.ts" } },
      ],
    } as const,
    { type: "toolcall_delta" } as const,
  );

  assert.equal(tracker.groupForTool("r1"), tracker.groupForTool("r2"));
  assert.deepEqual(tracker.groupForTool("r1")!.items.map((item) => item.toolCallId), ["r1", "r2"]);
});

test("updates lifecycle args/statuses and transitions active/explored", () => {
  const tracker = new ExplorationTracker();
  tracker.toolExecutionStart("r1", "read", { path: "src/old.ts" });
  tracker.toolExecutionUpdate("r1", "read", { path: "src/new.ts" });
  tracker.toolExecutionEnd("r1", "read", { output: "ok" }, false);
  tracker.toolExecutionStart("g1", "ffgrep", { path: "src", pattern: "TODO" });
  tracker.toolExecutionUpdate("g1", "ffgrep", { path: "src/lib", pattern: "TODO" });
  tracker.toolExecutionEnd("g1", "ffgrep", { details: { totalMatched: 17 } }, false);

  const readGroup = tracker.groupForTool("r1");
  const grepItem = tracker.groupForTool("g1")?.items.find((item) => item.toolCallId === "g1");
  assert.ok(readGroup);
  assert.ok(grepItem);
  assert.equal(readGroup.items[0]?.status, "completed");
  assert.equal(readGroup.items[0]?.args.path, "src/new.ts");
  assert.equal(grepItem.matchCount, 17);
  assert.equal(grepItem.status, "completed");

  const group = tracker.groupForTool("r1");
  assert.ok(group);
  assert.equal(stripTerminalSequences(renderExplorationGroup(group, 120, identityStyles)[0]!), "⠋ Exploring — 1 read, 1 search");

  tracker.settle();
  const settledHeader = stripTerminalSequences(renderExplorationGroup(group, 120, identityStyles)[0]!);
  assert.equal(settledHeader.includes("Explored — 1 read, 1 search"), true);
  assert.equal(group.active, false);
});

test("renders collapsed headers with exact text and width-safe long paths", () => {
  const tracker = new ExplorationTracker();
  tracker.toolExecutionStart("r1", "read", {
    path: "src/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ts",
  });
  tracker.toolExecutionStart("r2", "read", { path: "src/b.ts" });
  tracker.toolExecutionStart("s1", "fffind", { pattern: "TODO", path: "/tmp" });

  const group = tracker.groupForTool("r1");
  assert.ok(group);
  assert.equal(group.active, true);
  assert.equal(group.expanded, false);

  const collapsedHeader = stripTerminalSequences(renderExplorationGroup(group, 100, identityStyles)[0]!);
  assert.equal(collapsedHeader, "⠋ Exploring — 2 reads, 1 search");
  const collapsedLine = renderExplorationGroup(group, 100, identityStyles)[0]!;
  assert.ok(collapsedLine.includes(`pi-exploration://group/${group.id}`));

  tracker.toggle(group.id);
  const expandedLines = renderExplorationGroup(group, 22, identityStyles);
  assert.ok(expandedLines.every((line) => visibleWidth(line) <= 22));

  tracker.settle();
  assert.equal(
    stripTerminalSequences(renderExplorationGroup(group, 100, identityStyles)[0]!).includes(
      "Explored — 2 reads, 1 search",
    ),
    true,
  );
});

test("defaults groups collapsed, toggles one summary-only group and formats expanded read/find/grep details", () => {
  const tracker = new ExplorationTracker();
  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "r1", name: "read", arguments: { path: "/project/src/index.ts" } },
        { type: "toolCall", id: "f1", name: "fffind", arguments: { pattern: "TODO", path: "/project/src" } },
        { type: "toolCall", id: "g1", name: "ffgrep", arguments: { pattern: "FIXME", path: "/project/src" } },
      ],
    } as const,
    { type: "start" } as const,
  );

  tracker.toolExecutionEnd("g1", "ffgrep", { details: { totalMatched: 17 } }, false);
  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [{ type: "text", text: "boundary" }],
    } as const,
    { type: "toolcall_delta" } as const,
  );
  tracker.handleMessageUpdate(
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "r2",
          name: "read",
          arguments: {
            path: "/tmp/another/path/that/is-significantly/long-and-will-need-truncation-for-narrow-layout.ts",
          },
        },
      ],
    } as const,
    { type: "toolcall_delta" } as const,
  );

  const activeGroup = tracker.groupForTool("r1");
  const secondGroup = tracker.groupForTool("r2");
  assert.ok(activeGroup);
  assert.ok(secondGroup);
  assert.equal(activeGroup.expanded, false);
  assert.equal(secondGroup.expanded, false);

  tracker.toggle(activeGroup.id);
  const lines = renderExplorationGroup(activeGroup, 120, identityStyles);
  assert.equal(stripTerminalSequences(lines[0] ?? ""), "⌄ Explored — 1 read, 2 searches");
  assert.equal(lines[1], "  → Read /project/src/index.ts");
  assert.equal(lines[2], '  * Find "TODO" in /project/src');
  assert.equal(lines[3], '  * Grep "FIXME" in /project/src (17 matches)');
  assert.equal(renderExplorationGroup(secondGroup, 120, identityStyles).length, 1);
});

test("adds an error suffix on failed tool rows", () => {
  const tracker = new ExplorationTracker();
  tracker.toolExecutionStart("e1", "read", { path: "/tmp/missing.ts" });
  tracker.toolExecutionEnd("e1", "read", { details: {} }, true);
  const group = tracker.groupForTool("e1");
  assert.ok(group);

  tracker.toggle(group.id);
  const lines = renderExplorationGroup(group, 80, identityStyles);
  assert.equal(lines[1], "  → Read /tmp/missing.ts (error)");
});

test("installs click handler behavior for exploration links and delegates all others", (t) => {
  const tracker = new ExplorationTracker();
  tracker.toolExecutionStart("r1", "read", { path: "src/a.ts" });
  const group = tracker.groupForTool("r1");
  assert.ok(group);

  const calls: unknown[] = [];
  const originalOpenUrl = (url: string, ...args: unknown[]) => {
    calls.push([url, ...args]);
    return `delegated:${url}`;
  };
  let requestRenderCount = 0;
  const tui = {
    mode: "fullscreen",
    openUrl: originalOpenUrl,
    requestRender: () => {
      requestRenderCount += 1;
    },
  } as unknown as MockTUI;

  const cleanup = installExplorationClickHandler(tui, tracker);
  t.after(() => {
    cleanup();
  });

  const internalResult = tui.openUrl(`pi-exploration://group/${group.id}` as never);
  assert.equal(internalResult, undefined);
  assert.equal(requestRenderCount, 1);
  assert.equal(calls.length, 0);

  assert.equal(tui.openUrl("https://example.com/path" as never), "delegated:https://example.com/path");
  assert.equal(tui.openUrl("file:///tmp/somefile.txt" as never), "delegated:file:///tmp/somefile.txt");
  assert.equal(tui.openUrl("pi-exploration://group/" as never), "delegated:pi-exploration://group/");
  assert.equal(tui.openUrl("pi-exploration://group?x=1" as never), "delegated:pi-exploration://group?x=1");

  cleanup();
  assert.equal(tui.openUrl, originalOpenUrl);
  cleanup();
  assert.equal(tui.openUrl, originalOpenUrl);
  assert.equal(requestRenderCount, 1);
});

test("restores exploration groups from session entries with matcher counts and errors", () => {
  const tracker = new ExplorationTracker();
  tracker.restore([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r1",
            name: "read",
            arguments: { path: "src/main.ts" },
          },
          {
            type: "toolCall",
            id: "g1",
            name: "ffgrep",
            arguments: { path: "src", pattern: "TODO" },
          },
          { type: "toolCall", id: "shell", name: "bash", arguments: { command: "ls" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "g1",
        toolName: "ffgrep",
        details: { totalMatched: 17 },
      },
    },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "continued" }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "r2",
            name: "read",
            arguments: { path: "src/failing.ts" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "r2",
        toolName: "read",
        isError: true,
      },
    },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "next" }] } },
  ]);

  const firstGroup = tracker.groupForTool("r1");
  const secondGroup = tracker.groupForTool("r2");
  assert.ok(firstGroup);
  assert.ok(secondGroup);
  assert.equal(firstGroup.id, "group-0");
  assert.equal(secondGroup.id, "group-1");
  assert.equal(firstGroup.active, false);
  assert.equal(secondGroup.active, false);
  assert.equal(firstGroup.expanded, false);
  assert.equal(secondGroup.expanded, false);
  assert.deepEqual(firstGroup.items.map((item) => item.toolCallId), ["r1", "g1"]);
  assert.equal(firstGroup.items[1]?.matchCount, 17);
  assert.equal(secondGroup.items[0]?.status, "error");
  assert.equal(firstGroup.items[0]?.status, "completed");
  assert.equal(firstGroup.items[1]?.status, "completed");
});

test("patches and restores ToolExecutionComponent rendering via installation helper", (t) => {
  const tracker = new ExplorationTracker();
  initTheme();
  tracker.toolExecutionStart("r1", "read", { path: "src/a.ts" });
  tracker.toolExecutionStart("f1", "fffind", { pattern: "TODO", path: "src" });

  const theme = {
    fg: (_key: string, text: string) => text,
  } as unknown as Theme;
  installExplorationRenderer(tracker, theme);
  t.after(() => {
    clearExplorationRenderer(tracker);
  });

  const tui = {
    requestRender: () => {},
    openUrl: () => undefined,
    mode: "fullscreen",
  } as unknown as MockTUI;

  const leader = new ToolExecutionComponent(
    "read",
    "r1",
    {},
    undefined,
    undefined,
    tui,
    "/tmp",
  );
  const nonLeader = new ToolExecutionComponent(
    "fffind",
    "f1",
    {},
    undefined,
    undefined,
    tui,
    "/tmp",
  );

  const leaderLines = leader.render(80);
  assert.equal(leaderLines[0], "");
  assert.equal(
    stripTerminalSequences(leaderLines[1] ?? ""),
    "⠋ Exploring — 1 read, 1 search",
  );
  assert.deepEqual(nonLeader.render(80), []);
});
