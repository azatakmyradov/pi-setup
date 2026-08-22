import { describe, expect, it } from "vite-plus/test";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeCall, executeSearch } from "../proxy-modes.ts";
import { ConsentManager } from "../consent-manager.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { ContentBlock } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

function getText(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  throw new Error(`Expected text content, received ${content.type}`);
}

function createState(): McpExtensionState {
  const manager = new McpServerManager();
  return {
    config: {
      mcpServers: {
        demo: { command: "npx", args: ["demo"] },
      },
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_search",
            originalName: "search",
            description: "Search demo records",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      ],
    ]),
    manager,
    lifecycle: new McpLifecycleManager(manager),
    failureTracker: new Map(),
    projectCwd: "",
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("never"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => {},
  };
}

describe("proxy discovery", () => {
  it("searches MCP tools only", () => {
    const result = executeSearch(createState(), "read");

    expect(getText(result.content[0])).toBe('No tools matching "read"');
    expect(result.details).toMatchObject({ count: 0, matches: [] });
  });

  it("rejects regex queries longer than the safety cap", () => {
    const result = executeSearch(createState(), "a".repeat(257), true);

    expect(result.details).toMatchObject({ error: "query_too_long", maxLength: 256 });
  });

  it("reports malformed regex queries separately from unsafe patterns", () => {
    const result = executeSearch(createState(), "[", true);

    expect(result.details).toMatchObject({ error: "invalid_pattern" });
  });

  it("rejects catastrophic-backtracking regex queries", () => {
    const result = executeSearch(createState(), "(a+)+$", true);

    expect(result.details).toMatchObject({ error: "unsafe_pattern", safetyStatus: "vulnerable" });
  });

  it("accepts safe regex queries", () => {
    const result = executeSearch(createState(), "^demo_[a-z]+$", true);

    expect(result.details).toMatchObject({ count: 1, query: "^demo_[a-z]+$" });
  });

  it("keeps non-regex searches unaffected by the regex length cap", () => {
    const result = executeSearch(createState(), "search terms ".repeat(40), false);

    expect(result.details).not.toMatchObject({ error: "query_too_long" });
  });

  it("tells callers to invoke native Pi tools directly", async () => {
    const result = await executeCall(
      createState(),
      "read",
      undefined,
      undefined,
      () => [{
        name: "read",
        description: "Read a file",
        parameters: Type.Object({}),
        sourceInfo: createSyntheticSourceInfo("read", { source: "test" }),
      }],
    );

    expect(getText(result.content[0])).toBe(
      '"read" is a native Pi tool. Call read directly instead of using mcp({ tool: "read" }).',
    );
    expect(result.details).toMatchObject({ error: "native_tool", requestedTool: "read" });
  });
});
