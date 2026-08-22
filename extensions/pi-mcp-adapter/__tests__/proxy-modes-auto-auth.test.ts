import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { ConsentManager } from "../consent-manager.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import {
  McpServerManager,
  type ServerConnection,
} from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type {
  ContentBlock,
  McpConfig,
  McpResource,
  McpTool,
  ServerDefinition,
  ToolMetadata,
} from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

interface ClientMock {
  info: Implementation;
  options: ClientOptions | undefined;
  setRequestHandler: ReturnType<typeof vi.fn>;
  setNotificationHandler: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  listResources: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface StdioTransportMock {
  options: StdioServerParameters;
  close: ReturnType<typeof vi.fn>;
}

interface ProxyMocks {
  authenticate: ReturnType<typeof vi.fn>;
  supportsOAuth: ReturnType<typeof vi.fn>;
  lazyConnect: ReturnType<typeof vi.fn>;
  updateServerMetadata: ReturnType<typeof vi.fn>;
  updateMetadataCache: ReturnType<typeof vi.fn>;
  getFailureAgeSeconds: ReturnType<typeof vi.fn>;
  updateStatusBar: ReturnType<typeof vi.fn>;
  clients: ClientMock[];
  transports: StdioTransportMock[];
  connectImpl: ReturnType<typeof vi.fn>;
  listToolsImpl: ReturnType<typeof vi.fn>;
  listResourcesImpl: ReturnType<typeof vi.fn>;
  callToolImpl: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted((): ProxyMocks => ({
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
  lazyConnect: vi.fn(),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  updateStatusBar: vi.fn(),
  clients: [],
  transports: [],
  connectImpl: vi.fn(),
  listToolsImpl: vi.fn(),
  listResourcesImpl: vi.fn(),
  callToolImpl: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  updateServerMetadata: mocks.updateServerMetadata,
  updateMetadataCache: mocks.updateMetadataCache,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
}));

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
    this.connect = mocks.connectImpl;
    this.listTools = mocks.listToolsImpl;
    this.listResources = mocks.listResourcesImpl;
    this.callTool = mocks.callToolImpl;
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

function getText(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  throw new Error(`Expected text content, received ${content.type}`);
}

function createState(
  config: McpConfig,
  manager: McpServerManager,
  toolMetadata: Map<string, ToolMetadata[]> = new Map(),
  ui?: ExtensionUIContext,
): McpExtensionState {
  return {
    config,
    manager,
    lifecycle: new McpLifecycleManager(manager),
    toolMetadata,
    projectCwd: "",
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("never"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => {},
    ui,
  };
}

function createUi(): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
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

function createConnection(
  status: ServerConnection["status"],
  definition: ServerDefinition,
  tools: McpTool[] = [],
  resources: McpResource[] = [],
): ServerConnection {
  return {
    client: new Client({ name: "proxy-test", version: "1.0.0" }),
    transport: new StdioClientTransport({ command: "node", args: ["server.js"] }),
    definition,
    tools,
    resources,
    lastUsedAt: Date.now(),
    inFlight: 0,
    status,
  };
}

describe("proxy auto auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
    mocks.lazyConnect.mockReset().mockResolvedValue(false);
    mocks.updateServerMetadata.mockReset();
    mocks.updateMetadataCache.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.updateStatusBar.mockReset();
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.connectImpl.mockReset().mockResolvedValue(undefined);
    mocks.listToolsImpl.mockReset().mockResolvedValue({ tools: [] });
    mocks.listResourcesImpl.mockReset().mockResolvedValue({ resources: [] });
    mocks.callToolImpl.mockReset().mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("auto-authenticates and retries executeConnect once", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    const config: McpConfig = {
      settings: { autoAuth: true, toolPrefix: "server" },
      mcpServers: {
        demo: {
          url: "https://api.example.com/mcp",
          auth: "oauth",
        },
      },
    };
    const definition = config.mcpServers.demo;
    let current: ServerConnection | undefined;
    const needsAuth = createConnection("needs-auth", definition);
    const connected = createConnection(
      "connected",
      definition,
      [{ name: "search", description: "Search" }],
    );

    const manager = new McpServerManager();
    const connect = vi
      .spyOn(manager, "connect")
        .mockImplementationOnce(async () => {
          current = needsAuth;
          return current;
        })
        .mockImplementationOnce(async () => {
          current = connected;
          return current;
        });
    const close = vi.spyOn(manager, "close").mockImplementation(async () => {
      current = undefined;
    });
    vi.spyOn(manager, "getConnection").mockImplementation(() => current);

    const state = createState(config, manager, new Map(), createUi());

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(close).toHaveBeenCalledWith("demo");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(getText(result.content[0])).toContain("demo (1 tools)");
  });

  it("fails fast for non-ui browser auth when autoAuth is enabled", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    const config: McpConfig = {
      settings: { autoAuth: true },
      mcpServers: {
        demo: { url: "https://api.example.com/mcp", auth: "oauth" },
      },
    };
    const manager = new McpServerManager();
    const needsAuth = createConnection("needs-auth", config.mcpServers.demo);
    vi.spyOn(manager, "connect").mockResolvedValue(needsAuth);
    vi.spyOn(manager, "getConnection").mockReturnValue(needsAuth);

    const state = createState(config, manager);

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(getText(result.content[0])).toContain("auth-start");
    expect(getText(result.content[0])).toContain("/mcp-auth demo");
  });

  it("uses custom authRequiredMessage for non-ui autoAuth failures", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    const config: McpConfig = {
      settings: {
        autoAuth: true,
        authRequiredMessage: "Reconnect ${server} from the host app.",
      },
      mcpServers: {
        demo: { url: "https://api.example.com/mcp", auth: "oauth" },
      },
    };
    const manager = new McpServerManager();
    const needsAuth = createConnection("needs-auth", config.mcpServers.demo);
    vi.spyOn(manager, "connect").mockResolvedValue(needsAuth);
    vi.spyOn(manager, "getConnection").mockReturnValue(needsAuth);
    const state = createState(config, manager);

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(getText(result.content[0])).toBe("Reconnect demo from the host app.");
  });

  it("runs URL elicitations returned by proxy tool calls", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/sdk/types.js");
    const { executeCall } = await import("../proxy-modes.ts");
    const error = new UrlElicitationRequiredError([{
      mode: "url",
      message: "Connect your account",
      elicitationId: "connect-1",
      url: "https://example.com/connect",
    }]);
    const config: McpConfig = {
      settings: {},
      mcpServers: { demo: { command: "demo" } },
    };
    const connection = createConnection("connected", config.mcpServers.demo);
    vi.spyOn(connection.client, "callTool").mockRejectedValue(error);
    const manager = new McpServerManager();
    vi.spyOn(manager, "getConnection").mockReturnValue(connection);
    const handleUrlElicitationRequired = vi
      .spyOn(manager, "handleUrlElicitationRequired")
      .mockResolvedValue("accept");
    const state = createState(
      config,
      manager,
      new Map<string, ToolMetadata[]>([
        ["demo", [{
          name: "demo_search",
          originalName: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        }]],
      ]),
    );

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(handleUrlElicitationRequired).toHaveBeenCalledWith("demo", error);
    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
  });

  it("auto-authenticates and retries executeCall once", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const config: McpConfig = {
      settings: { autoAuth: true, toolPrefix: "server" },
      mcpServers: {
        demo: {
          url: "https://api.example.com/mcp",
          auth: "oauth",
        },
      },
    };
    let current: ServerConnection | undefined = createConnection(
      "needs-auth",
      config.mcpServers.demo,
    );
    const connected = createConnection(
      "connected",
      config.mcpServers.demo,
      [{ name: "search", description: "Search" }],
    );

    const manager = new McpServerManager();
    const connect = vi.spyOn(manager, "connect").mockImplementation(async () => {
      current = connected;
      return connected;
    });
    vi.spyOn(manager, "close").mockImplementation(async () => {
      current = undefined;
    });
    vi.spyOn(manager, "getConnection").mockImplementation(() => current);
    const getRequestOptions = vi
      .spyOn(manager, "getRequestOptions")
      .mockReturnValue({ timeout: 1234 });

    const state = createState(
      config,
      manager,
      new Map<string, ToolMetadata[]>([
        [
          "demo",
          [
            {
              name: "demo_search",
              originalName: "search",
              description: "Search",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        ],
      ]),
      createUi(),
    );

    const controller = new AbortController();
    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo", undefined, controller.signal);

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(mocks.callToolImpl).toHaveBeenCalledWith(
      {
        name: "search",
        arguments: { q: "hello" },
        _meta: undefined,
      },
      undefined,
      { timeout: 1234 },
    );
    expect(getText(result.content[0])).toContain("ok");
  });

  it("surfaces aborted proxy tool calls via the forwarded AbortSignal", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const controller = new AbortController();

    const requestOptions = { signal: controller.signal, timeout: 1234 };
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: { demo: { command: "demo" } },
    };
    const connection = createConnection("connected", config.mcpServers.demo);
    const callTool = vi.spyOn(connection.client, "callTool").mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const manager = new McpServerManager();
    vi.spyOn(manager, "getConnection").mockReturnValue(connection);
    const getRequestOptions = vi
      .spyOn(manager, "getRequestOptions")
      .mockReturnValue(requestOptions);
    const state = createState(
      config,
      manager,
      new Map<string, ToolMetadata[]>([
        ["demo", [{
          name: "demo_search",
          originalName: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        }]],
      ]),
    );

    const inFlight = executeCall(state, "demo_search", {}, "demo", undefined, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("request aborted"));

    const result = await inFlight;

    expect(getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: {}, _meta: undefined },
      undefined,
      requestOptions,
    );
    expect(result.details).toMatchObject({ error: "call_failed", message: "request aborted" });
    expect(getText(result.content[0])).toContain("request aborted");
  });

  it("shares one cold connect across concurrent proxy calls and applies timeout during bootstrap", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
    mocks.connectImpl.mockImplementation(async () => {
      await pause();
    });
    mocks.listToolsImpl.mockImplementation(async () => {
      await pause();
      return {
        tools: [{
          name: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        }],
      };
    });
    mocks.listResourcesImpl.mockImplementation(async () => {
      await pause();
      return { resources: [] };
    });
    mocks.lazyConnect.mockImplementation(async (state: McpExtensionState, serverName: string) => {
      const connection = await state.manager.connect(serverName, state.config.mcpServers[serverName]);
      if (connection.status !== "connected") {
        return false;
      }
      state.toolMetadata.set(serverName, [{
        name: "demo_search",
        originalName: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
      }]);
      return true;
    });

    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);
    const state = createState(
      {
        settings: { toolPrefix: "server" },
        mcpServers: {
          demo: { command: "node", args: ["server.js"], requestTimeoutMs: 5000 },
        },
      },
      manager,
    );

    const [first, second] = await Promise.all([
      executeCall(state, "demo_search", { q: "one" }),
      executeCall(state, "demo_search", { q: "two" }),
    ]);

    expect(mocks.clients).toHaveLength(1);
    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 5000 });
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.listResources).toHaveBeenCalledTimes(1);
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.callTool).toHaveBeenNthCalledWith(
      1,
      { name: "search", arguments: { q: "one" }, _meta: undefined },
      undefined,
      { timeout: 5000 },
    );
    expect(client.callTool).toHaveBeenNthCalledWith(
      2,
      { name: "search", arguments: { q: "two" }, _meta: undefined },
      undefined,
      { timeout: 5000 },
    );
    expect(getText(first.content[0])).toContain("ok");
    expect(getText(second.content[0])).toContain("ok");
  });
});
