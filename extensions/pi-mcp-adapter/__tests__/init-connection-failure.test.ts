import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ServerDefinition } from "../types.ts";

interface ManagerDouble {
  setDefaultRequestTimeoutMs: ReturnType<typeof vi.fn>;
  setSamplingConfig: ReturnType<typeof vi.fn>;
  setElicitationConfig: ReturnType<typeof vi.fn>;
  getConnection: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
  const managers: ManagerDouble[] = [];
  return {
    connect: vi.fn(),
    loadMcpConfig: vi.fn(),
    managers,
    runMcp: vi.fn(),
    saveMetadataCache: vi.fn(),
  };
});

vi.mock("../config.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../direct-tools-catalog.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../direct-tools-catalog.ts")>()),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
}));

vi.mock("../effect/runtime.ts", () => ({
  createMcpRuntime: vi.fn(() => ({})),
  mcpConnect: vi.fn(),
  mcpStatus: {},
  runMcp: mocks.runMcp,
}));

vi.mock("../metadata-cache.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../metadata-cache.ts")>()),
  getMetadataCachePath: vi.fn(() => "/tmp/pi-mcp-adapter-missing-cache.json"),
  loadMetadataCache: vi.fn(() => null),
}));

vi.mock("../metadata-cache-writer.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../metadata-cache-writer.ts")>()),
  saveMetadataCache: mocks.saveMetadataCache,
}));

vi.mock("../project-state.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../project-state.ts")>()),
  getRememberedServers: vi.fn(() => new Set<string>()),
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: vi.fn().mockImplementation(function (this: ManagerDouble) {
    this.setDefaultRequestTimeoutMs = vi.fn();
    this.setSamplingConfig = vi.fn();
    this.setElicitationConfig = vi.fn();
    this.getConnection = vi.fn();
    this.connect = mocks.connect;
    mocks.managers.push(this);
  }),
}));

function context(notify: ReturnType<typeof vi.fn>): ExtensionContext {
  const contextDouble = {
    cwd: "/tmp/project",
    hasUI: true,
    mode: "tui" as const,
    ui: {
      notify,
      setStatus: vi.fn(),
    },
    modelRegistry: {},
    model: undefined,
    signal: undefined,
  };
  // SAFETY: initializeMcp reads only the context members supplied by this test double.
  return contextDouble as typeof contextDouble & ExtensionContext;
}

function extensionApi(): ExtensionAPI {
  const apiDouble = {
    getFlag: vi.fn(),
    sendMessage: vi.fn(),
  };
  // SAFETY: initializeMcp reads only the API members supplied by this test double.
  return apiDouble as typeof apiDouble & ExtensionAPI;
}

describe("initializeMcp connection failures", () => {
  beforeEach(() => {
    mocks.managers.length = 0;
    mocks.connect.mockReset().mockRejectedValue(new Error("connection closed"));
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        x3: { command: "x3-mcp", lifecycle: "keep-alive" } satisfies ServerDefinition,
      },
      settings: {},
    });
    mocks.runMcp.mockReset().mockResolvedValue([]);
    mocks.saveMetadataCache.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tracks startup and health-check failures without writing them into the chat", async () => {
    const { initializeMcp } = await import("../init.ts");
    const { logger } = await import("../logger.ts");
    const notify = vi.fn();
    const ctx = context(notify);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

    const state = await initializeMcp(extensionApi(), ctx);
    await state.lifecycle.checkConnectionsOnce();

    expect(state.failureTracker.has("x3")).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("MCP: Failed to connect to x3: connection closed");
    expect(debug).toHaveBeenCalledWith("MCP: Failed to reconnect to x3: connection closed");
  });
});
