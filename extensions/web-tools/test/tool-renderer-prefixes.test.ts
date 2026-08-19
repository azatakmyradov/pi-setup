import assert from "node:assert/strict";
import test from "node:test";
import { createWebFetchTool } from "../webfetch.ts";
import { createWebSearchTool } from "../websearch.ts";

const plainTheme = {
  fg: (_key: string, text: string) => text,
  bold: (text: string) => text,
};

test("websearch tool header render has no custom search prefix", () => {
  const tool = createWebSearchTool();
  const call = tool.renderCall({ query: "weather tomorrow" }, plainTheme).render(120).join("\n");
  assert.equal(call.startsWith("Search"), true);
  assert.equal(call.includes("⌕"), false);
});

test("websearch partial result keeps searching progress text", () => {
  const tool = createWebSearchTool();
  const result = tool.renderResult({ content: [{ type: "text", text: "..." }] }, {
    isPartial: true,
    expanded: false,
  }, plainTheme, {});
  assert.equal(result.render(120).join("\n").includes("searching"), true);
});

test("webfetch tool header render has no custom fetch prefix", () => {
  const tool = createWebFetchTool();
  const call = tool.renderCall({ url: "https://example.com/page" }, plainTheme).render(120).join("\n");
  assert.equal(call.startsWith("Fetch"), true);
  assert.equal(call.includes("↓"), false);
});

test("webfetch partial result keeps fetching progress text", () => {
  const tool = createWebFetchTool();
  const result = tool.renderResult({ content: [{ type: "text", text: "..." }] }, {
    isPartial: true,
    expanded: false,
  }, plainTheme, {});
  assert.equal(result.render(120).join("\n").includes("fetching"), true);
});
