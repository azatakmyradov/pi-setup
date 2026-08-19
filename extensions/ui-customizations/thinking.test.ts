import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  collectThoughtRuns,
  renderThought,
  runDuration,
  streamingThoughtTitle,
  thoughtBody,
  thoughtTitle,
} from "./thinking.ts";

const styles = {
  collapsed: (text: string) => `<c>${text}</c>`,
  header: (text: string) => `<h>${text}</h>`,
  body: (text: string) => `<b>${text}</b>`,
  bar: (text: string) => `<|>${text}</|>`,
};

test("groups consecutive thinking blocks the way Pi renders them", () => {
  const runs = collectThoughtRuns([
    { type: "thinking", thinking: "**One**" },
    { type: "thinking", thinking: "  " },
    { type: "thinking", thinking: "**Two**" },
    { type: "text" },
    { type: "thinking", thinking: "**Three**" },
    { type: "toolCall" },
    { type: "thinking", thinking: "   " },
  ]);

  assert.deepEqual(runs, [["**One**", "**Two**"], ["**Three**"]]);
});

test("reads the headline from a reasoning summary title", () => {
  assert.equal(
    thoughtTitle("**Using glob in distribution configuration**"),
    "Using glob in distribution configuration",
  );
  assert.equal(thoughtTitle("plain reasoning text"), "plain reasoning text");
  assert.equal(thoughtTitle("   "), undefined);
});

test("streaming headline follows the newest title", () => {
  const text = "**Planning the fix**\n\n**Designing the footer**";
  assert.equal(streamingThoughtTitle(text), "Designing the footer");
  assert.equal(thoughtTitle(text), "Planning the fix");
});

test("body drops title markers but keeps paragraph breaks", () => {
  assert.equal(thoughtBody(["**One**", "**Two**"]), "One\n\nTwo");
});

test("run duration sums the blocks that were timed", () => {
  const durations = new Map([
    ["**One**", 700],
    ["**Two**", 300],
  ]);
  assert.equal(runDuration(["**One**", "**Two**"], durations), 1_000);
  assert.equal(runDuration(["**One**", "**Missing**"], durations), 700);
  assert.equal(runDuration(["**Missing**"], durations), undefined);
});

test("collapsed thoughts are one line with headline and duration", () => {
  const lines = renderThought(
    {
      blocks: ["**Using glob in distribution configuration**"],
      durationMs: 2_700,
    },
    false,
    80,
    1,
    styles,
  );

  assert.deepEqual(lines, [" <c>+ Thought: Using glob in distribution configuration · 2.7s</c>"]);
});

test("collapsed thoughts drop the duration until one is recorded", () => {
  const lines = renderThought({ blocks: ["**Working**"] }, false, 80, 1, styles);
  assert.deepEqual(lines, [" <c>+ Thought: Working</c>"]);
});

test("expanded thoughts show a header and a barred body", () => {
  const lines = renderThought(
    {
      blocks: ["**Searching for dist directory using glob**"],
      durationMs: 856,
    },
    true,
    40,
    1,
    styles,
  );

  assert.deepEqual(lines, [
    " <h>- Thought · 856ms</h>",
    "",
    " <|>▏</|> <b>Searching for dist directory using</b>",
    " <|>▏</|> <b>glob</b>",
  ]);
});

test("expanded thoughts keep the bar unbroken between paragraphs", () => {
  const lines = renderThought(
    { blocks: ["**One**", "**Two**"], durationMs: 40 },
    true,
    40,
    0,
    styles,
  );

  assert.deepEqual(lines, [
    "<h>- Thought · 40ms</h>",
    "",
    "<|>▏</|> <b>One</b>",
    "<|>▏</|>",
    "<|>▏</|> <b>Two</b>",
  ]);
});

test("collapsed thoughts stay inside the available width", () => {
  const [line] = renderThought(
    { blocks: [`**${"headline ".repeat(20)}**`], durationMs: 1_200 },
    false,
    30,
    2,
    { ...styles, collapsed: (text) => text },
  );

  assert.ok(visibleWidth(line!) <= 30);
});
