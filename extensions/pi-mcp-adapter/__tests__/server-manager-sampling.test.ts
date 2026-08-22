import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

interface ClientMock {
  info: Implementation;
  options: ClientOptions | undefined;
  setRequestHandler: ReturnType<typeof vi.fn>;
  setNotificationHandler: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  listResources: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface StdioTransportMock {
  options: StdioServerParameters;
  close: ReturnType<typeof vi.fn>;
}

interface ConnectedMocks {
  clients: ClientMock[];
  transports: StdioTransportMock[];
  open: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted((): ConnectedMocks => ({
  clients: [],
  transports: [],
  open: vi.fn(async () => undefined),
}));

const modelRegistryPromise = ModelRuntime.create({
  allowModelNetwork: false,
  modelsPath: null,
  refreshOnCreate: false,
}).then((runtime) => new ModelRegistry(runtime));

function createUi(
  select: ExtensionUIContext["select"] = async () => undefined,
  notify: ExtensionUIContext["notify"] = () => {},
): ExtensionUIContext {
  return {
    select,
    confirm: async () => false,
    input: async () => undefined,
    notify,
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>() => Promise.reject<T>(new Error("Custom UI is not used in this test")),
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme(): never {
      throw new Error("Theme is not used in this test");
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

vi.mock("open", () => ({ default: mocks.open }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (
    this: ClientMock,
    info: Implementation,
    options?: ClientOptions,
  ) {
    this.info = info;
    this.options = options;
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async () => undefined);
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (
    this: StdioTransportMock,
    options: StdioServerParameters,
  ) {
    this.options = options;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager sampling", () => {
  const originalMcpTestCwd = process.env.MCP_TEST_CWD;

  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.open.mockClear();
  });

  afterEach(() => {
    if (originalMcpTestCwd === undefined) {
      delete process.env.MCP_TEST_CWD;
    } else {
      process.env.MCP_TEST_CWD = originalMcpTestCwd;
    }
  });

  it("advertises sampling and registers the handler before connecting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: await modelRegistryPromise,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toEqual({ capabilities: { sampling: {} } });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises elicitation capabilities and registers the handler before connecting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({
      allowUrl: true,
      ui: createUi(),
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toEqual({
      capabilities: {
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises form-only elicitation when URL navigation is unavailable", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: false, ui: createUi() });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toEqual({
      capabilities: { elicitation: { form: {} } },
    });
  });

  it("notifies only when a known URL elicitation completes", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Open");
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    const ui = createUi(select, notify);
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: true, ui });
    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    const requestHandler = client.setRequestHandler.mock.calls[0][1];
    await requestHandler({
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Connect",
        elicitationId: "known-id",
        url: "https://example.com/connect",
      },
    });
    const completionHandler = client.setNotificationHandler.mock.calls[0][1];
    completionHandler({ params: { elicitationId: "unknown-id" } });
    completionHandler({ params: { elicitationId: "known-id" } });
    completionHandler({ params: { elicitationId: "known-id" } });

    expect(notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(notify).toHaveBeenCalledWith(
      "MCP browser interaction for demo completed. You can retry the tool now.",
      "info",
    );
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("handles every URL in a URL-required error", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/sdk/types.js");
    const { McpServerManager } = await import("../server-manager.ts");
    const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Open");
    const ui = createUi(select);
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: true, ui });
    const result = await manager.handleUrlElicitationRequired("demo", new UrlElicitationRequiredError([
      { mode: "url", message: "First", elicitationId: "one", url: "https://example.com/one" },
      { mode: "url", message: "Second", elicitationId: "two", url: "https://example.com/two" },
    ]));

    expect(result).toBe("accept");
    expect(mocks.open).toHaveBeenNthCalledWith(1, "https://example.com/one");
    expect(mocks.open).toHaveBeenNthCalledWith(2, "https://example.com/two");
  });

  it("advertises sampling and elicitation together", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: await modelRegistryPromise,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });
    manager.setElicitationConfig({
      allowUrl: true,
      ui: createUi(),
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toEqual({
      capabilities: {
        sampling: {},
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(mocks.clients[0].setRequestHandler).toHaveBeenCalledTimes(2);
  });

  it("does not advertise sampling when no sampling config is set", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toBeUndefined();
    expect(client.setRequestHandler).not.toHaveBeenCalled();
  });

  it("expands environment variables and tilde in stdio cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_CWD = "/tmp/pi-mcp-cwd";

    const envManager = new McpServerManager();
    await envManager.connect("env-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "${MCP_TEST_CWD}/nested",
    });

    const homeManager = new McpServerManager();
    await homeManager.connect("home-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "~/nested",
    });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-mcp-cwd/nested" });
    expect(mocks.transports[1].options).toMatchObject({ cwd: join(homedir(), "nested") });
  });

  it("uses the session cwd for stdio servers without an explicit cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager("/tmp/pi-session-cwd");

    await manager.connect("session-cwd", { command: "node", args: ["server.js"] });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-session-cwd" });
  });

  it("prefers an explicit stdio cwd over the session cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager("/tmp/pi-session-cwd");

    await manager.connect("explicit-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "/tmp/server-cwd",
    });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/server-cwd" });
  });

  it("applies the global timeout to connect and discovery requests", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 2500 });
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 2500 });
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 2500 });
  });

  it("prefers the per-server timeout for connect and discovery requests", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"], requestTimeoutMs: 5000 });

    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 5000 });
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 5000 });
  });

  it("builds request options from global and per-server timeouts", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"], requestTimeoutMs: 5000 });
    await manager.connect("sdk-default", { command: "node", args: ["server.js"], requestTimeoutMs: 0 });

    const signal = new AbortController().signal;
    expect(manager.getRequestOptions("demo", signal)).toEqual({ signal, timeout: 5000 });
    expect(manager.getRequestOptions("missing", signal)).toEqual({ signal, timeout: 2500 });
    expect(manager.getRequestOptions("missing")).toEqual({ timeout: 2500 });
    expect(manager.getRequestOptions("sdk-default")).toBeUndefined();

    manager.setDefaultRequestTimeoutMs(0);
    expect(manager.getRequestOptions("missing")).toBeUndefined();
  });
});
