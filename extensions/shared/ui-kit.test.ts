import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  alignColumns,
  collapsedPreview,
  configuredKeys,
  keyLabelFor,
  deniedText,
  formatTokens,
  gutterLines,
  GUTTER,
  truncateLines,
  type KeyLookup,
  type ThemeText,
} from "./ui-kit.ts";

// keyHint (used by expandHint) reads the global theme the TUI normally initializes.
initTheme("dark", false);

/** Plain-text themer: the assertions below compare uncolored output. */
const theme: ThemeText & { strikethrough: (text: string) => string } = {
  fg: (_color, text) => text,
  strikethrough: (text) => `~${text}~`,
};

test("formatTokens uses one compact scale across every magnitude", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1_234), "1.2k");
  assert.equal(formatTokens(45_000), "45k");
  assert.equal(formatTokens(1_234_567), "1.2M");
  assert.equal(formatTokens(12_000_000), "12M");
});

test("alignColumns pads to width and truncates the left column first", () => {
  assert.equal(alignColumns("left", "right", 20), "left           right");
  // pi-tui appends an SGR reset when it truncates; compare visible text only.
  const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(stripAnsi(alignColumns("a-very-long-left-side", "right", 16)), "a-very-l…  right");
  assert.equal(alignColumns("left", "", 8), "left");
  // A short left column lets the right column exceed its nominal budget.
  assert.equal(alignColumns("ab", "a-long-right-side", 21), "ab  a-long-right-side");
  assert.equal(alignColumns("left", "right", 0), "");
});

test("truncateLines keeps the budget and marks the cut with a lone ellipsis line", () => {
  const lines = ["1", "2", "3", "4", "5"];
  assert.deepEqual(truncateLines(lines, 5), lines);
  assert.deepEqual(truncateLines(lines, 3), ["1", "2", "…"]);
  assert.deepEqual(truncateLines([], 3), []);
});

test("gutterLines prefixes every line with the shared gutter glyph", () => {
  assert.deepEqual(gutterLines(theme, ["a", "b"]), [`${GUTTER} a`, `${GUTTER} b`]);
  assert.equal(GUTTER, "┃");
});

test("deniedText strikes through instead of coloring red", () => {
  assert.equal(deniedText(theme, "dismissed"), "~dismissed~");
});

test("collapsedPreview cuts the body and appends an expand hint only when needed", () => {
  const short = collapsedPreview(theme, "head", "one\ntwo", 3);
  assert.equal(short, "head\none\ntwo");

  const long = collapsedPreview(theme, "head", "1\n2\n3\n4", 3).split("\n");
  assert.deepEqual(long.slice(0, 3), ["head", "1", "2"]);
  assert.equal(long[3], "…");
  assert.match(long[4] ?? "", /expand/);
});

test("keyLabelFor reads the configured keys and falls back to unbound", () => {
  const keybindings: KeyLookup = {
    getKeys: (id) => (id === "tui.select.up" ? ["up", "k"] : []),
  };
  assert.equal(configuredKeys(keybindings, "tui.select.up"), "up/k");
  assert.deepEqual(keyLabelFor(keybindings, "tui.select.down", "down"), ["unbound", "down"]);
});
