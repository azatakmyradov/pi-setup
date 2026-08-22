import { describe, expect, it, vi } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { abortable } from "../abort.ts";
import { ConsentManager } from "../consent-manager.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeConnect } from "../proxy-modes.ts";
import { lazyConnect } from "../init.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpConfig, McpResource, ServerDefinition } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

type CallResultContent = Awaited<ReturnType<typeof executeCall>>["content"][number];

const definition = {
  command: "node",
  args: ["server.js"],
} satisfies ServerDefinition;

function getText(content: CallResultContent): string {
  if (content.type === "text") return content.text;
  throw new Error(`Expected text content, received ${content.type}`);
}

function createConnection(client: Client): ServerConnection {
  return {
    client,
    transport: new StdioClientTransport({ command: process.execPath }),
    definition,
    tools: [],
    resources: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status: "connected",
  };
}

function createState(
  manager: McpServerManager,
  config: McpConfig = { mcpServers: { demo: definition } },
): McpExtensionState {
  return {
    manager,
    lifecycle: new McpLifecycleManager(manager),
    config,
    projectCwd: process.cwd(),
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_slow",
            originalName: "slow",
            description: "Slow tool",
          },
        ],
      ],
    ]),
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("once-per-server"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: () => Promise.resolve(),
  };
}

function connectedState(client: Client) {
  const manager = new McpServerManager();
  vi.spyOn(manager, "getConnection").mockReturnValue(createConnection(client));
  const decrementInFlight = vi.spyOn(manager, "decrementInFlight");
  vi.spyOn(manager, "getRequestOptions").mockImplementation(
    (_server: string, signal?: AbortSignal) => signal ? { signal } : undefined,
  );
  return {
    state: createState(manager, {
      settings: { toolPrefix: "server" },
      mcpServers: { demo: definition },
    }),
    decrementInFlight,
  };
}

interface ResourceDiscoveryHarness {
  fetchAllResources(client: Client, options?: RequestOptions): Promise<McpResource[]>;
}

function resourceDiscoveryHarness(manager: McpServerManager): ResourceDiscoveryHarness {
  // SAFETY: fetchAllResources is a concrete prototype method; this focused test
  // reaches it directly to verify abort behavior without opening a transport.
  return manager as McpServerManager & ResourceDiscoveryHarness;
}

describe("AbortSignal propagation", () => {
  it("abortable rejects promptly when the host signal aborts", async () => {
    const controller = new AbortController();
    const inFlight = abortable(new Promise<never>(() => {}), controller.signal);

    controller.abort(new Error("user cancelled"));

    await expect(inFlight).rejects.toThrow("user cancelled");
  });

  it("direct tools pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
    const controller = new AbortController();
    const client = new Client({ name: "abort-test", version: "1.0.0" });
    const callTool = vi.spyOn(client, "callTool").mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const { state, decrementInFlight } = connectedState(client);
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "slow",
        prefixedName: "demo_slow",
        description: "Slow tool",
      },
    );

    const inFlight = execute("call-1", {}, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("user cancelled"));

    const result = await inFlight;
    expect(getText(result.content[0])).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("call_failed");
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      undefined,
      { signal: controller.signal },
    );
    expect(decrementInFlight).toHaveBeenCalledWith("demo");
  });

  it("proxy tool calls pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
    const controller = new AbortController();
    const client = new Client({ name: "abort-test", version: "1.0.0" });
    const callTool = vi.spyOn(client, "callTool").mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const { state, decrementInFlight } = connectedState(client);

    const inFlight = executeCall(state, "demo_slow", {}, undefined, undefined, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("user cancelled"));

    const result = await inFlight;
    expect(getText(result.content[0])).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("call_failed");
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      undefined,
      { signal: controller.signal },
    );
    expect(decrementInFlight).toHaveBeenCalledWith("demo");
  });

  it("proxy connect passes AbortSignal to manager.connect and does not record aborts as server failures", async () => {
    const controller = new AbortController();
    const manager = new McpServerManager();
    const connection = createConnection(new Client({ name: "abort-test", version: "1.0.0" }));
    const connect = vi.spyOn(manager, "connect").mockImplementation(
      async (_name, _definition, signal?: AbortSignal) => {
        controller.abort(new Error("user cancelled"));
        signal?.throwIfAborted();
        return connection;
      },
    );
    const state = createState(manager);

    const result = await executeConnect(state, "demo", controller.signal);

    expect(result.details.error).toBe("aborted");
    expect(connect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, controller.signal);
    expect(state.failureTracker.size).toBe(0);
  });

  it("lazyConnect rethrows host aborts without updating the failure backoff", async () => {
    const controller = new AbortController();
    const manager = new McpServerManager();
    const connection = createConnection(new Client({ name: "abort-test", version: "1.0.0" }));
    vi.spyOn(manager, "connect").mockImplementation(
      async (_name, _definition, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return connection;
      },
    );
    const state = createState(manager);

    controller.abort(new Error("user cancelled"));

    await expect(lazyConnect(state, "demo", controller.signal)).rejects.toThrow("user cancelled");
    expect(state.failureTracker.size).toBe(0);
  });

  it("server-manager resource discovery does not swallow host aborts", async () => {
    const controller = new AbortController();
    const client = new Client({ name: "abort-test", version: "1.0.0" });
    vi.spyOn(client, "listResources").mockImplementation(
      async (_params, options?: RequestOptions) => {
        options?.signal?.throwIfAborted();
        return { resources: [] };
      },
    );
    const manager = new McpServerManager();

    controller.abort(new Error("user cancelled"));

    await expect(
      resourceDiscoveryHarness(manager).fetchAllResources(
        client,
        { signal: controller.signal },
      ),
    ).rejects.toThrow("user cancelled");
  });

  it("server-manager readResource passes AbortSignal through the MCP SDK request options", async () => {
    const controller = new AbortController();
    const client = new Client({ name: "abort-test", version: "1.0.0" });
    const readResource = vi.spyOn(client, "readResource").mockResolvedValue({ contents: [] });
    const manager = new McpServerManager();
    Object.defineProperty(manager, "connections", {
      value: new Map([["demo", createConnection(client)]]),
    });

    await manager.readResource("demo", "resource://demo", controller.signal);

    expect(readResource).toHaveBeenCalledWith(
      { uri: "resource://demo" },
      { signal: controller.signal },
    );
  });
});
