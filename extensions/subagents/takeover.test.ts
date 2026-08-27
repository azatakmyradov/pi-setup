import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  reconcileDashboardSelection,
  statusWord,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("queued subagents read as queued in the dashboard", () => {
  const theme = { fg: (_color, text) => text } satisfies Pick<Theme, "fg">;
  const base: SubagentSnapshot = {
    id: "sa-3",
    origin: "model",
    backend: "pi",
    title: "Check pi-tui API",
    prompt: "Check the pi-tui API",
    cwd: "/tmp/project",
    status: "queued",
    createdAt: 1_000,
    meta: { backend: "pi" },
    usage: {},
    compacting: false,
    compactionCount: 0,
    cancelled: false,
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };

  assert.equal(statusWord(base, theme), "queued");
  assert.equal(statusWord({ ...base, status: "running" }, theme), "running");
  assert.equal(statusWord({ ...base, status: "done" }, theme), "done");
  assert.equal(statusWord({ ...base, status: "error" }, theme), "failed");
});
