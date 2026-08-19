import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatActivityCounts,
  formatActivityStatus,
} from "./activity-status.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Parameters<typeof formatActivityCounts>[0];

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
