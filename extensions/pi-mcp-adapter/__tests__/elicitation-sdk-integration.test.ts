import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConsentManager } from "../consent-manager.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import type { ElicitationUIContext } from "../elicitation-handler.ts";
import { isTuiMode } from "../init.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { DirectToolSpec, ToolMetadata } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const mocks = vi.hoisted(() => ({ open: vi.fn(async () => undefined) }));
vi.mock("open", () => ({ default: mocks.open }));

const fixture = fileURLToPath(new URL("./fixtures/elicitation-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

function createUi(answers: string[] = []): ElicitationUIContext {
  return {
    select: vi.fn(async () => answers.shift()),
    input: vi.fn(async () => "stock-pi-user"),
    notify: vi.fn(),
  };
}

async function createConnectedManager(mode: ExtensionContext["mode"], answers: string[] = []) {
  const ui = createUi(answers);
  const manager = new McpServerManager();
  manager.setElicitationConfig({
    ui,
    allowUrl: isTuiMode({ hasUI: true, mode }),
  });
  await manager.connect("real", definition);
  managers.push(manager);
  return { manager, ui };
}

function createState(manager: McpServerManager, metadata: ToolMetadata[]): McpExtensionState {
  return {
    manager,
    lifecycle: new McpLifecycleManager(manager),
    config: { settings: {}, mcpServers: { real: definition } },
    projectCwd: process.cwd(),
    toolMetadata: new Map([["real", metadata]]),
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("once-per-server"),
    completedUiSessions: [],
    uiServer: null,
    openBrowser: () => Promise.resolve(),
  };
}

type ClientCallToolResult = Awaited<ReturnType<ServerConnection["client"]["callTool"]>>;

function resultText(result: ClientCallToolResult): string {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content.find((item) => item.type === "text");
  return content?.type === "text" ? content.text : "";
}

describe("elicitation with the real MCP SDK", () => {
  beforeEach(() => mocks.open.mockClear());

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  });

  it.each([
    ["tui", { form: {}, url: {} }],
    ["rpc", { form: {} }],
  ] as const)("advertises stock Pi %s capabilities and completes form elicitation", async (mode, capabilities) => {
    const { manager } = await createConnectedManager(mode, ["Continue", "Enter value", "Submit"]);
    const connection = manager.getConnection("real")!;

    const capabilityResult = await connection.client.callTool({ name: "capabilities", arguments: {} });
    expect(JSON.parse(resultText(capabilityResult))).toEqual(capabilities);

    const formResult = await connection.client.callTool({ name: "form", arguments: {} });
    expect(JSON.parse(resultText(formResult))).toEqual({
      action: "accept",
      content: { name: "stock-pi-user" },
    });
  });

  it("rejects URL elicitation over real SDK dispatch in stock Pi RPC mode", async () => {
    const { manager } = await createConnectedManager("rpc");
    const connection = manager.getConnection("real")!;

    await expect(connection.client.callTool({ name: "url", arguments: {} })).rejects.toThrow(
      /does not support URL-mode elicitation requests/,
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("dispatches URL elicitation and its completion notification over the real SDK", async () => {
    const { manager, ui } = await createConnectedManager("tui", ["Open"]);
    const connection = manager.getConnection("real")!;

    const result = await connection.client.callTool({ name: "url", arguments: {} });

    expect(JSON.parse(resultText(result))).toEqual({ action: "accept" });
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/authorize");
    const notify = vi.spyOn(ui, "notify");
    expect(notify).toHaveBeenCalledWith(
      "MCP browser interaction for real completed. You can retry the tool now.",
      "info",
    );
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["proxy tool", { originalName: "url-required" }, "proxy"],
    ["direct tool", { originalName: "url-required" }, "direct"],
    ["proxy resource", { originalName: "resource", resourceUri: "test://url-required" }, "proxy"],
    ["direct resource", { originalName: "resource", resourceUri: "test://url-required" }, "direct"],
    ["proxy UI resource", { originalName: "app", uiResourceUri: "ui://url-required" }, "proxy"],
    ["direct UI resource", { originalName: "app", uiResourceUri: "ui://url-required" }, "direct"],
  ] as const)("handles real -32042 errors from a %s", async (_label, spec, adapter) => {
    const { manager } = await createConnectedManager("tui", ["Open"]);
    const metadata: ToolMetadata = {
      name: `real_${spec.originalName}`,
      description: "integration test",
      ...spec,
    };
    const state = createState(manager, [metadata]);

    const directSpec = {
      serverName: "real",
      prefixedName: metadata.name,
      description: metadata.description,
      ...spec,
    } satisfies DirectToolSpec;
    const result = adapter === "proxy"
      ? await executeCall(state, metadata.name, {}, "real")
      : await createDirectToolExecutor(
          () => state,
          () => null,
          directSpec,
        )("id", {}, undefined);

    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("retry the tool"),
    });
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/connect");
  });
});
