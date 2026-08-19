import { describe, expect, it } from "vitest";
import { Cause, Exit } from "effect";
import {
  createMcpRuntime,
  mcpCall,
  mcpConnect,
  mcpStatus,
  runMcp,
} from "../effect/runtime.ts";
import type { McpConfig, ToolMetadata } from "../types.ts";

function connectedManager(connection: Record<string, unknown>) {
  return {
    getConnection: () => connection,
    getAllConnections: () => new Map([["demo", connection]]),
    connect: async () => connection,
    close: async () => undefined,
    closeAll: async () => undefined,
    touch: () => undefined,
    incrementInFlight: () => undefined,
    decrementInFlight: () => undefined,
    getRequestOptions: () => undefined,
  };
}

describe("Effect MCP runtime", () => {
  it("deduplicates concurrent connects while keeping waiter cancellation local", async () => {
    let resolveConnect!: (connection: Record<string, unknown>) => void;
    let connectCount = 0;
    const connection = {
      definition: { command: "fixture" },
      tools: [],
      resources: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
      status: "connected" as const,
    };
    const manager = {
      getConnection: () => undefined,
      getAllConnections: () => new Map(),
      connect: () => {
        connectCount++;
        return new Promise<Record<string, unknown>>((resolve) => {
          resolveConnect = resolve;
        });
      },
      close: async () => undefined,
      closeAll: async () => undefined,
      touch: () => undefined,
      incrementInFlight: () => undefined,
      decrementInFlight: () => undefined,
      getRequestOptions: () => undefined,
    };
    const config: McpConfig = { mcpServers: { demo: { command: "fixture" } } };
    const runtime = createMcpRuntime({ manager, config, getMetadata: () => new Map() });
    const first = new AbortController();
    const second = new AbortController();

    const firstWaiter = runMcp(runtime, mcpConnect("demo"), { signal: first.signal });
    const secondWaiter = runMcp(runtime, mcpConnect("demo"), { signal: second.signal });
    await Promise.resolve();
    expect(connectCount).toBe(1);

    first.abort(new Error("first waiter cancelled"));
    await expect(firstWaiter).rejects.toThrow();
    resolveConnect(connection);
    await expect(secondWaiter).resolves.toMatchObject({ name: "demo", status: "connected" });
    await runtime.dispose();
  });

  it("keeps authentication failures typed inside the Effect boundary", async () => {
    const connection = {
      definition: { url: "https://example.test/mcp" },
      tools: [],
      resources: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
      status: "needs-auth" as const,
    };
    const manager = connectedManager(connection);
    manager.connect = async () => connection;
    const config: McpConfig = { mcpServers: { demo: { url: "https://example.test/mcp" } } };
    const runtime = createMcpRuntime({ manager, config, getMetadata: () => new Map() });

    const exit = await runtime.runPromiseExit(mcpConnect("demo"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause) as { readonly _tag?: string; readonly server?: string };
      expect(failure._tag).toBe("AuthenticationRequiredError");
      expect(failure.server).toBe("demo");
    }
    await runtime.dispose();
  });

  it("owns cleanup and routes raw calls through the same service", async () => {
    let closed = 0;
    const connection = {
      client: {
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
      definition: { command: "fixture" },
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      resources: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
      status: "connected" as const,
    };
    const manager = {
      ...connectedManager(connection),
      closeAll: async () => { closed++; },
    };
    const config: McpConfig = { mcpServers: { demo: { command: "fixture" } } };
    const metadata = new Map<string, ToolMetadata[]>([
      ["demo", [{ name: "demo_echo", originalName: "echo", description: "Echo", inputSchema: { type: "object" } }]],
    ]);
    const runtime = createMcpRuntime({ manager, config, getMetadata: () => metadata });

    expect(await runMcp(runtime, mcpStatus)).toMatchObject([{ name: "demo", status: "connected" }]);
    const result = await runMcp(runtime, mcpCall({ server: "demo", tool: "demo_echo", arguments: {} }));
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    await runtime.dispose();
    expect(closed).toBe(1);
  });
});
