import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConsentManager } from "../consent-manager.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { ContentBlock, McpConfig, ToolMetadata } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

// End-to-end coverage for the structuredContent fallback.

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
}));

interface ResultWithContent {
  content: ContentBlock[];
}

function textOf(result: ResultWithContent): string {
  return result.content
    .map((content) => content.type === "text" ? content.text : "")
    .join("\n");
}

function makeState(callToolResult: CallToolResult, toolName = "tool"): McpExtensionState {
  const config: McpConfig = {
    settings: {},
    mcpServers: { demo: { command: "demo" } },
  };
  const client = new Client({ name: "structured-content-test", version: "1.0.0" });
  vi.spyOn(client, "callTool").mockResolvedValue(callToolResult);
  const connection: ServerConnection = {
    client,
    transport: new StdioClientTransport({ command: "node", args: ["server.js"] }),
    definition: config.mcpServers.demo,
    tools: [],
    resources: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status: "connected",
  };
  const manager = new McpServerManager();
  vi.spyOn(manager, "getConnection").mockReturnValue(connection);
  return {
    config,
    toolMetadata: new Map<string, ToolMetadata[]>([
      ["demo", [{ name: `demo_${toolName}`, originalName: toolName, description: toolName }]],
    ]),
    manager,
    lifecycle: new McpLifecycleManager(manager),
    projectCwd: "",
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("never"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => {},
  };
}

describe("structuredContent fallback — direct tool executor", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("surfaces structuredContent to the model when content is empty", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const structured = { status: "available", summary: "## Notes" };
    const state = makeState({ isError: false, content: [], structuredContent: structured });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "get-summary", prefixedName: "demo_get-summary", description: "Get summary" },
    );

    const result = await executor("id", {}, undefined);

    expect(textOf(result)).toBe(JSON.stringify(structured, null, 2));
    expect(textOf(result)).not.toContain("(empty result)");
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const state = makeState({ isError: false, content: [] });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "noop", prefixedName: "demo_noop", description: "Noop" },
    );

    const result = await executor("id", {}, undefined);

    expect(textOf(result)).toBe("(empty result)");
  });
});

describe("structuredContent fallback — proxy executeCall", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("surfaces structuredContent to the model when content is empty", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const structured = { status: "available", summary: "## Notes" };
    const state = makeState({ isError: false, content: [], structuredContent: structured }, "get-summary");

    const result = await executeCall(state, "demo_get-summary", {}, "demo");

    expect(textOf(result)).toContain(JSON.stringify(structured, null, 2));
    expect(textOf(result)).not.toContain("(empty result)");
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const state = makeState({ isError: false, content: [] }, "noop");

    const result = await executeCall(state, "demo_noop", {}, "demo");

    expect(textOf(result)).toContain("(empty result)");
  });
});
