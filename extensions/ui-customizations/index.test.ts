import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  addUserMessageBorder,
  alignColumns,
  createScannerFrames,
  formatDuration,
  formatTokens,
  layoutEditorPanel,
  promptWidth,
} from "./index.ts";

test("uses the OpenCode home width only before a conversation starts", () => {
  assert.equal(promptWidth(120, true), 75);
  assert.equal(promptWidth(60, true), 60);
  assert.equal(promptWidth(120, false), 120);
});

test("turn metadata uses compact OpenCode-style durations and token counts", () => {
  assert.equal(formatDuration(865), "865ms");
  assert.equal(formatDuration(2_340), "2.3s");
  assert.equal(formatTokens(5_120), "5.1k");
});

test("working spinner scans continuously with a trailing shadow", () => {
  assert.deepEqual(createScannerFrames(4), [
    "■···",
    "▪■··",
    "•▪■·",
    "·•▪■",
    "··■▪",
    "·■▪•",
  ]);
});

test("replaces editor borders with a centered left-edge panel and metadata row", () => {
  const cursor = "\x1b[7m \x1b[0m";
  const lines = layoutEditorPanel(
    ["─────", `${cursor}    `, "─────", "item "],
    12,
    10,
    "Build",
    {
      border: (text) => `\x1b[31m${text}\x1b[39m`,
      background: (text) => `\x1b[40m${text}\x1b[49m`,
      placeholder: (text) => `\x1b[2m${text}\x1b[22m`,
    },
    "Ask anything...",
  );

  assert.equal(lines.length, 6);
  assert.equal(visibleWidth(lines[0]!), 11);
  assert.match(lines[0]!, /^ /);
  assert.ok(lines[1]!.includes("Ask"));
  assert.ok(lines[3]!.includes("Build"));
  assert.ok(lines[5]!.includes("item"));
  assert.ok(lines.slice(0, 5).every((line) => !line.includes("\x1b[0m")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
});

test("adds an accent border beside user messages without changing width", () => {
  const lines = addUserMessageBorder(
    ["\x1b]133;A\x07\x1b[40m abcde \x1b[49m", "\x1b[40m      \x1b[49m"],
    (text) => `\x1b[35m${text}\x1b[39m`,
  );

  assert.equal(visibleWidth(lines[0]!), 7);
  assert.equal(
    lines[0],
    "\x1b]133;A\x07\x1b[40m\x1b[35m│\x1b[39m abcde\x1b[49m",
  );
  assert.equal(visibleWidth(lines[1]!), 6);
  assert.equal(
    lines[1],
    `\x1b[40m\x1b[35m│\x1b[39m${"\u00a0".repeat(5)}\x1b[49m`,
  );
});

test("footer columns stay within narrow terminal widths", () => {
  const line = alignColumns(
    "~/project",
    "5.1k (1%)  shift+tab thinking  ctrl+l models",
    32,
  );
  assert.ok(visibleWidth(line) <= 32);
  assert.ok(line.includes("5.1k"));
});
