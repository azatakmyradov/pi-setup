import assert from "node:assert/strict";
import test from "node:test";
import { truncateHeadTail } from "./src/truncate.ts";

test("text inside both budgets is returned unchanged", () => {
  const text = "line one\nline two\nline three";
  const result = truncateHeadTail(text, { maxBytes: 1_024, maxLines: 100 });

  assert.equal(result.truncated, false);
  assert.equal(result.text, text);
});

test("a long transcript keeps its first and last lines around one marker", () => {
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index}`);
  const result = truncateHeadTail(lines.join("\n"), {
    maxBytes: 64 * 1_024,
    maxLines: 30,
  });

  assert.equal(result.truncated, true);
  const outputLines = result.text.split("\n");
  assert.equal(outputLines[0], "line 0");
  assert.equal(outputLines.at(-1), "line 399");
  assert.equal(outputLines.filter((line) => line.startsWith("[…")).length, 1);
  // ~2/3 head, ~1/3 tail, plus the marker line.
  assert.equal(outputLines.length, 31);
  assert.ok(outputLines.includes("line 19"));
  assert.ok(outputLines.includes("line 390"));
  assert.match(result.text, /omitted 370 lines \/ \d+ bytes …\]/);
});

test("the byte budget bounds the output even with few lines", () => {
  const text = Array.from({ length: 40 }, (_, index) => `${index}: ${"x".repeat(200)}`).join("\n");
  const result = truncateHeadTail(text, { maxBytes: 1_000, maxLines: 500 });

  assert.equal(result.truncated, true);
  const withoutMarker = result.text
    .split("\n")
    .filter((line) => !line.startsWith("[…"))
    .join("\n");
  assert.ok(Buffer.byteLength(withoutMarker, "utf8") <= 1_000);
  assert.match(result.text, /^0: x+/);
  assert.match(result.text, /39: x+$/);
});

test("multibyte text is never split mid code point", () => {
  // One line only, so both ends fall back to code-point slicing.
  const text = "🙂".repeat(500);
  const result = truncateHeadTail(text, { maxBytes: 300, maxLines: 50 });

  assert.equal(result.truncated, true);
  const [head, marker, ...rest] = result.text.split("\n");
  assert.ok(marker?.startsWith("[…"));
  assert.equal(rest.length, 1);
  assert.doesNotMatch(result.text, /�/);
  assert.equal(
    Array.from(head ?? "").every((codePoint) => codePoint === "🙂"),
    true,
  );
  assert.equal(
    Array.from(rest[0] ?? "").every((codePoint) => codePoint === "🙂"),
    true,
  );
  assert.ok(Buffer.byteLength(head ?? "", "utf8") <= 200);
});

test("the marker names the session file when one is known", () => {
  const result = truncateHeadTail(Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n"), {
    maxBytes: 8 * 1_024,
    maxLines: 10,
    sessionFilePath: "/tmp/session-42.jsonl",
  });

  assert.match(result.text, /full transcript in \/tmp\/session-42\.jsonl …\]/);
});

test("tailShare 0 degrades to head-only truncation", () => {
  const result = truncateHeadTail(Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"), {
    maxBytes: 8 * 1_024,
    maxLines: 5,
    tailShare: 0,
  });

  const lines = result.text.split("\n");
  assert.equal(lines[0], "l0");
  assert.equal(lines.at(-1)?.startsWith("[…"), true);
});
