import assert from "node:assert/strict";
import { test } from "node:test";
import { formatActivityCounts, formatActivityStatus } from "./activity-status.ts";
import type { ThemeText } from "./ui-kit.ts";

/** Plain-text themer: the assertions below compare uncolored output. */
const theme: ThemeText = {
  fg: (_color, text) => text,
};

test("formats subagent counts without a command instruction", () => {
  assert.equal(
    formatActivityCounts(theme, "subagents", {
      running: 1,
      done: 2,
      failed: 1,
    }),
    "subagents: ● 1 running · ✓ 2 done · ✗ 1 failed",
  );
});

test("keeps the view instruction for linked activity statuses", () => {
  assert.equal(
    formatActivityStatus(theme, "workflows", {
      running: 1,
      done: 0,
      failed: 0,
    }),
    "workflows: ● 1 running · /workflows to view",
  );
});

test("uses a separate command when the view command differs from the label", () => {
  assert.equal(
    formatActivityStatus(theme, "terminals", { running: 2, done: 0, failed: 0 }, "ps"),
    "terminals: ● 2 running · /ps to view",
  );
});
