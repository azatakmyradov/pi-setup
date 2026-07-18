import assert from "node:assert/strict";
import test from "node:test";
import { claudeToolPolicy, claudeTools } from "./src/backends/claude.ts";

test("Claude tool allowlists translate Pi read-only tool names", () => {
  assert.deepEqual(claudeTools(["read", "grep", "find", "ls"]), [
    "Read",
    "Grep",
    "Glob",
  ]);
});

test("Claude tool allowlists preserve backend-native and unknown names", () => {
  assert.deepEqual(claudeTools(["Read", "custom_tool", "read"]), [
    "Read",
    "custom_tool",
  ]);
});

test("Claude tool policies isolate the allowlist from settings and MCP tools", () => {
  assert.deepEqual(claudeToolPolicy(["read", "grep"], "/repo"), {
    tools: ["Read", "Grep"],
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    settings: { disableAllHooks: true },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ["/repo"] },
    },
  });
});
