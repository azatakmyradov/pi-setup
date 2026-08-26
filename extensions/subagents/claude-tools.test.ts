import assert from "node:assert/strict";
import test from "node:test";
import { claudeToolPolicy, claudeTools } from "./src/backends/claude.ts";

test("Claude tool allowlists translate Pi read-only tool names", () => {
  assert.deepEqual(claudeTools(["read", "grep", "find", "ls"]), ["Read", "Grep", "Glob"]);
});

test("Claude tool allowlists preserve backend-native and unknown names", () => {
  assert.deepEqual(claudeTools(["Read", "custom_tool", "read"]), ["Read", "custom_tool"]);
});

test("Claude tool policies keep a read-only tool set from writing to the workspace", () => {
  assert.deepEqual(claudeToolPolicy(["read", "grep"], "/repo"), {
    tools: ["Read", "Grep"],
    disallowedTools: ["Agent", "Task"],
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

test("Claude tool policies let a write-capable tool set change the workspace", () => {
  assert.deepEqual(claudeToolPolicy(["read", "bash"], "/repo"), {
    tools: ["Read", "Bash"],
    disallowedTools: ["Agent", "Task"],
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    settings: { disableAllHooks: true },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    },
  });
  for (const tool of ["edit", "write", "Edit", "Write", "Bash"]) {
    assert.equal(
      "filesystem" in claudeToolPolicy(["read", tool], "/repo").sandbox,
      false,
      `${tool} should not be sandboxed out of writing`,
    );
  }
});
