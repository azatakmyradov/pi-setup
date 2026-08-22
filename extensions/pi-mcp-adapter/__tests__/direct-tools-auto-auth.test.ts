import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
  ServerDefinition,
} from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

function getText(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  throw new Error(`Expected text content, received ${content.type}`);
}

function createState(
  config: McpConfig,
  manager: McpServerManager,
  ui?: ExtensionUIContext,
): McpExtensionState {
  return {
    config,
    manager,
    lifecycle: new McpLifecycleManager(manager),
    toolMetadata: new Map(),
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
): ServerConnection {
  return {
    client: new Client({ name: "direct-tool-test", version: "1.0.0" }),
    transport: new StdioClientTransport({ command: "node", args: ["server.js"] }),
    definition,
    tools: [],
    resources: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status,
  };
}

describe("direct tools auto auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
  });

  it("auto-authenticates and retries direct tool execution once", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const config: McpConfig = {
      settings: { autoAuth: true },
      mcpServers: {
        demo: {
          url: "https://api.example.com/mcp",
          auth: "oauth",
        },
      },
    };
    let connection: ServerConnection | undefined = createConnection(
      "needs-auth",
      config.mcpServers.demo,
    );
    const connected = createConnection("connected", config.mcpServers.demo);
    const callTool = vi.spyOn(connected.client, "callTool").mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });

    mocks.lazyConnect
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => {
        connection = connected;
        return true;
      });

    const manager = new McpServerManager();
    const close = vi.spyOn(manager, "close").mockImplementation(async () => {
      connection = undefined;
    });
    vi.spyOn(manager, "getConnection").mockImplementation(() => connection);
    const getRequestOptions = vi
      .spyOn(manager, "getRequestOptions")
      .mockReturnValue({ timeout: 4321 });
    const state = createState(config, manager, createUi());

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const controller = new AbortController();
    const result = await executor("id", { q: "hello" }, controller.signal);

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(close).toHaveBeenCalledWith("demo");
    expect(getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "search",
        arguments: { q: "hello" },
        _meta: undefined,
      },
      undefined,
      { timeout: 4321 },
    );
    expect(getText(result.content[0])).toContain("ok");
  });

  it("surfaces aborted direct tool calls via the forwarded AbortSignal", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const controller = new AbortController();

    const requestOptions = { signal: controller.signal, timeout: 4321 };
    const config: McpConfig = {
      settings: {},
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
    const state = createState(config, manager);
    mocks.lazyConnect.mockResolvedValue(true);

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    const inFlight = executor("id", {}, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("request aborted"));

    const result = await inFlight;

    expect(getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: {}, _meta: undefined },
      undefined,
      requestOptions,
    );
    expect(result.details).toMatchObject({ error: "call_failed", server: "demo" });
    expect(getText(result.content[0])).toContain("request aborted");
  });

  it("fails fast in non-ui context for browser-based OAuth", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const config: McpConfig = {
      settings: { autoAuth: true },
      mcpServers: {
        demo: { url: "https://api.example.com/mcp", auth: "oauth" },
      },
    };
    const manager = new McpServerManager();
    const needsAuth = createConnection("needs-auth", config.mcpServers.demo);
    vi.spyOn(manager, "getConnection").mockReturnValue(needsAuth);
    const state = createState(config, manager);

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", {}, undefined);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(getText(result.content[0])).toContain("auth-start");
    expect(getText(result.content[0])).toContain("/mcp-auth demo");
  });

  it("runs URL elicitations returned by a URL-required tool error", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/sdk/types.js");
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
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
    const state = createState(config, manager);
    mocks.lazyConnect.mockResolvedValue(true);

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });
    const result = await executor("id", {}, undefined);

    expect(handleUrlElicitationRequired).toHaveBeenCalledWith("demo", error);
    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
    expect(getText(result.content[0])).toContain("retry the tool");
  });

  it("uses custom authRequiredMessage in non-ui direct tool auth failures", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

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
    vi.spyOn(manager, "getConnection").mockReturnValue(needsAuth);
    const state = createState(config, manager);

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", {}, undefined);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(getText(result.content[0])).toBe("Reconnect demo from the host app.");
  });
});
