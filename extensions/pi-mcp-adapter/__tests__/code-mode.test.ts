import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as CodeMode from "../vendor/opencode-codemode/src/codemode.ts";
import * as Tool from "../vendor/opencode-codemode/src/tool.ts";
import {
  createCodeModeExecutor,
  resolveCodeModeSettings,
} from "../code-mode.ts";
import { createMcpRuntime } from "../effect/runtime.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpConfig, ToolMetadata } from "../types.ts";

function echoTools() {
  return {
    demo: {
      echo: Tool.make({
        description: "Echo JSON data",
        input: { type: "object", properties: {} },
        run: (input) => Effect.succeed(input),
      }),
    },
  };
}

describe("confined code mode", () => {
  it("uses safe defaults and requires explicit opt-in", () => {
    expect(resolveCodeModeSettings(undefined)).toMatchObject({
      enabled: false,
      timeoutMs: 60_000,
      maxToolCalls: 20,
      maxOutputBytes: 50 * 1024,
    });
    expect(resolveCodeModeSettings(true).enabled).toBe(true);
    expect(resolveCodeModeSettings({ enabled: true, maxToolCalls: 2 })).toMatchObject({
      enabled: true,
      maxToolCalls: 2,
    });
  });

  it("executes transformations without a JavaScript host escape hatch", async () => {
    const runtime = CodeMode.make({ tools: echoTools() });
    const result = await Effect.runPromise(runtime.execute(`
      const value = await tools.demo.echo({ value: 4 })
      return { doubled: value.value * 2 }
    `));

    expect(result).toMatchObject({ ok: true, value: { doubled: 8 } });

    const escapeAttempt = await Effect.runPromise(runtime.execute("return process"));
    expect(escapeAttempt).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" } });

    const importAttempt = await Effect.runPromise(runtime.execute("return eval(\"1 + 1\")"));
    expect(importAttempt).toMatchObject({ ok: false });
  });

  it("enforces child-call and execution-time budgets", async () => {
    const limited = CodeMode.make({
      tools: echoTools(),
      limits: { maxToolCalls: 1 },
    });
    const tooMany = await Effect.runPromise(limited.execute(`
      await tools.demo.echo({ first: true })
      await tools.demo.echo({ second: true })
      return true
    `));
    expect(tooMany).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } });

    const timed = CodeMode.make({
      tools: echoTools(),
      limits: { timeoutMs: 10 },
    });
    const timeout = await Effect.runPromise(timed.execute("while (true) {}"));
    expect(timeout).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
  });

  it("uses the shared MCP runtime for child calls and reports progress", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connection = {
      client: {
        callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
          calls.push({ name: request.name, args: request.arguments ?? {} });
          return {
            content: [],
            structuredContent: { items: [{ name: "effect", stars: 42 }] },
          };
        },
      },
      transport: {},
      definition: { command: "fixture" },
      tools: [{
        name: "search",
        description: "Search repositories",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      }],
      resources: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
      status: "connected" as const,
    };
    const manager = {
      getConnection: () => connection,
      getAllConnections: () => new Map([["github", connection]]),
      connect: async () => connection,
      close: async () => undefined,
      closeAll: async () => undefined,
      touch: () => undefined,
      incrementInFlight: () => undefined,
      decrementInFlight: () => undefined,
      getRequestOptions: () => undefined,
    };
    const config: McpConfig = {
      mcpServers: { github: { command: "fixture" } },
      settings: { codeMode: true },
    };
    const metadata = new Map<string, ToolMetadata[]>([
      ["github", [{
        name: "github_search",
        originalName: "search",
        description: "Search repositories",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      }]],
    ]);
    const runtime = createMcpRuntime({
      manager,
      config,
      getMetadata: () => metadata,
    });
    const state = {
      runtime,
      manager,
      config,
      toolMetadata: metadata,
    } as unknown as McpExtensionState;
    const updates: Array<unknown> = [];
    const execute = createCodeModeExecutor(() => state, () => null);

    try {
      const result = await execute(
        "call-1",
        {
          code: `
            const repos = await tools.github.search({ query: "effect ts" })
            return repos.structuredContent.items.map((item) => ({ name: item.name, stars: item.stars }))
          `,
        },
        undefined,
        (update) => updates.push(update),
        {} as never,
      );

      expect(calls).toEqual([{ name: "search", args: { query: "effect ts" } }]);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.details).toMatchObject({
        mode: "code",
        result: [{ name: "effect", stars: 42 }],
        childCalls: [{ name: "github.search", status: "success" }],
      });
      expect(updates.length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("interrupts a pending child call when the parent signal aborts", async () => {
    let aborted = false;
    const connection = {
      client: {
        callTool: async (_request: unknown, _result?: unknown, options?: { signal?: AbortSignal }) => await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
      },
      transport: {},
      definition: { command: "fixture" },
      tools: [{ name: "wait", description: "Wait", inputSchema: { type: "object", properties: {} } }],
      resources: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
      status: "connected" as const,
    };
    const manager = {
      getConnection: () => connection,
      getAllConnections: () => new Map([["demo", connection]]),
      connect: async () => connection,
      close: async () => undefined,
      closeAll: async () => undefined,
      touch: () => undefined,
      incrementInFlight: () => undefined,
      decrementInFlight: () => undefined,
      getRequestOptions: (_name: string, signal?: AbortSignal) => ({ signal }),
    };
    const config: McpConfig = { mcpServers: { demo: { command: "fixture" } }, settings: { codeMode: true } };
    const metadata = new Map<string, ToolMetadata[]>([["demo", [{
      name: "demo_wait",
      originalName: "wait",
      description: "Wait",
      inputSchema: { type: "object", properties: {} },
    }]]]);
    const runtime = createMcpRuntime({ manager, config, getMetadata: () => metadata });
    const state = { runtime, manager, config, toolMetadata: metadata } as unknown as McpExtensionState;
    const controller = new AbortController();
    const execute = createCodeModeExecutor(() => state, () => null);
    const pending = execute("call-1", { code: "await tools.demo.wait({}); return true" }, controller.signal, undefined, {} as never);
    setTimeout(() => controller.abort(), 10);

    try {
      await expect(pending).rejects.toThrow("aborted");
      expect(aborted).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
