import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { appendExpandedPreview, appendExpandHint } from "../render.ts";

// keyHint reads the global theme, which the TUI normally initializes.
initTheme("dark", false);

/** Leaves text unstyled so assertions compare visible characters. */
const plainTheme = { fg: (_name: string, value: string) => value };

test("an expanded preview keeps its line budget and marks the cut with a lone ellipsis", () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  const rendered = appendExpandedPreview("head", text, plainTheme, { maxLines: 12 }).split("\n");

  assert.equal(rendered.length, 13);
  assert.deepEqual(rendered.slice(1), [
    ...Array.from({ length: 11 }, (_, index) => `line ${index + 1}`),
    "…",
  ]);
});

test("a preview inside the line budget carries no cut marker", () => {
  const rendered = appendExpandedPreview("head", "one\ntwo", plainTheme).split("\n");
  assert.deepEqual(rendered, ["head", "one", "two"]);
});

test("the expand hint is built from the configured keybinding", () => {
  const hint = appendExpandHint("head", false);
  assert.match(hint, /details/);
  assert.doesNotMatch(hint, /\(ctrl\+o to expand\)/);
  assert.equal(appendExpandHint("head", true), "head");
});
