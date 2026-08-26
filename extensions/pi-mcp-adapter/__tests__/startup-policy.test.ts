import { describe, expect, it } from "vite-plus/test";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import { startupPolicyRequiresRuntime } from "../startup-policy.ts";
import type { McpConfig } from "../types.ts";

function validCache(config: McpConfig): MetadataCache {
  return {
    version: 1,
    servers: Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, definition]) => [
        name,
        {
          configHash: computeServerHash(definition),
          tools: [],
          resources: [],
          cachedAt: Date.now(),
        },
      ]),
    ),
  };
}

describe("MCP startup policy", () => {
  it("keeps lazy servers with valid cached metadata fully lazy", () => {
    const config: McpConfig = {
      mcpServers: { x3: { command: "x3-server", lifecycle: "lazy" } },
      settings: { codeMode: true },
    };

    expect(startupPolicyRequiresRuntime(
      config,
      validCache(config),
      new Set(),
      true,
      true,
    )).toBe(false);
  });

  it("initializes eager and remembered keep-alive servers", () => {
    const eager: McpConfig = {
      mcpServers: { demo: { command: "demo-server", lifecycle: "eager" } },
    };
    const remembered: McpConfig = {
      mcpServers: { demo: { command: "demo-server" } },
    };

    expect(startupPolicyRequiresRuntime(
      eager,
      validCache(eager),
      new Set(),
      true,
      true,
    )).toBe(true);
    expect(startupPolicyRequiresRuntime(
      remembered,
      validCache(remembered),
      new Set(["demo"]),
      true,
      true,
    )).toBe(true);
  });

  it("initializes to bootstrap the cache or missing configured direct tools", () => {
    const lazy: McpConfig = {
      mcpServers: { demo: { command: "demo-server", lifecycle: "lazy" } },
    };
    const direct: McpConfig = {
      mcpServers: {
        demo: { command: "demo-server", lifecycle: "lazy", directTools: true },
      },
    };

    expect(startupPolicyRequiresRuntime(
      lazy,
      null,
      new Set(),
      false,
      true,
    )).toBe(true);
    expect(startupPolicyRequiresRuntime(
      direct,
      { version: 1, servers: {} },
      new Set(),
      true,
      true,
    )).toBe(true);
    expect(startupPolicyRequiresRuntime(
      direct,
      { version: 1, servers: {} },
      new Set(),
      true,
      false,
    )).toBe(false);
  });
});
