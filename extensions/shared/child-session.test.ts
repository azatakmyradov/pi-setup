import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bindChildSessionExtensions,
  CHILD_EXCLUDED_TOOL_NAMES,
  childToolPolicy,
  createChildResources,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  type DisposableChildSession,
} from "./child-session.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-child-policy-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("child denylist keeps extension and workflow structured tools available", async () => {
  await withTempDir(async (directory) => {
    let starts = 0;
    let shutdowns = 0;
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const inlineLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            starts++;
          });
          pi.on("session_shutdown", () => {
            shutdowns++;
          });
          for (const name of ["fixture_extension_tool", ...CHILD_EXCLUDED_TOOL_NAMES]) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: "ok" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await inlineLoader.reload();

    const structuredOutput = defineTool({
      name: "structured_output",
      label: "Structured Output",
      description: "fixture structured result",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: params.value }],
          details: {},
        };
      },
    });
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      resourceLoader: inlineLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      customTools: [structuredOutput],
      ...childToolPolicy(),
    });
    await bindChildSessionExtensions(session);

    assert.deepEqual(
      [...CHILD_EXCLUDED_TOOL_NAMES],
      [
        "subagent_spawn",
        "subagent_cancel",
        "subagent_check",
        "subagent_list",
        "workflow",
        "ask_user",
      ],
    );
    const allTools = new Set(session.getAllTools().map((tool) => tool.name));
    const activeTools = new Set(session.getActiveToolNames());
    assert.equal(starts, 1);
    assert.equal(allTools.has("fixture_extension_tool"), true);
    assert.equal(activeTools.has("fixture_extension_tool"), true);
    assert.equal(allTools.has("structured_output"), true);
    assert.equal(activeTools.has("structured_output"), true);
    for (const denied of CHILD_EXCLUDED_TOOL_NAMES) {
      assert.equal(allTools.has(denied), false, `${denied} should be denied`);
      assert.equal(activeTools.has(denied), false, `${denied} should be inactive`);
    }
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.equal(activeTools.has(builtin), true, `${builtin} should stay active`);
    }

    await Promise.all([
      shutdownAndDisposeChildSession(session),
      shutdownAndDisposeChildSession(session),
    ]);
    assert.equal(shutdowns, 1);
  });
});

test("resource loading gates project extensions but retains global extensions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    const extensionSource = (name: string) => `
      export default function (pi) {
        pi.registerTool({
          name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
          description: "fixture", parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `;
    await writeFile(
      path.join(agentDir, "extensions", "global.ts"),
      extensionSource("global_fixture"),
    );
    await writeFile(
      path.join(cwd, ".pi", "extensions", "project.ts"),
      extensionSource("project_fixture"),
    );

    const untrusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const untrustedTools = untrusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(untrustedTools.includes("global_fixture"), true);
    assert.equal(untrustedTools.includes("project_fixture"), false);

    const trusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const trustedTools = trusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(trustedTools.includes("global_fixture"), true);
    assert.equal(trustedTools.includes("project_fixture"), true);
  });
});

test(
  "native child MCP respects project trust and can call server tools",
  { timeout: 15_000 },
  async () => {
    await withTempDir(async (directory) => {
      const cwd = path.join(directory, "project");
      const agentDir = path.join(directory, "agent");
      const serverPath = path.join(directory, "mcp-server.mjs");
      await mkdir(path.join(cwd, ".pi"), { recursive: true });
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        serverPath,
        `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result = {};
        if (request.method === "initialize") {
          result = {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" }
          };
        } else if (request.method === "tools/list") {
          result = { tools: [{
            name: "echo", description: "Read-only test tool",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true }
          }] };
        } else if (request.method === "tools/call") {
          result = { content: [{ type: "text", text: "native MCP fixture" }] };
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      });
    `,
      );
      await writeFile(
        path.join(cwd, ".pi", "mcp.json"),
        JSON.stringify({
          mcpServers: { fixture: { command: process.execPath, args: [serverPath] } },
        }),
      );

      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const untrusted = await createChildResources({ cwd, agentDir, projectTrusted: false });
        const { session: untrustedSession } = await createAgentSession({
          cwd,
          agentDir,
          resourceLoader: untrusted.loader,
          settingsManager: untrusted.settingsManager,
          sessionManager: SessionManager.inMemory(cwd),
          ...childToolPolicy(),
        });
        try {
          await bindChildSessionExtensions(untrustedSession);
          await untrustedSession.prompt("/mcp reconnect fixture");
          assert.equal(
            untrustedSession.getAllTools().some((tool) => tool.name.startsWith("mcp__")),
            false,
          );
        } finally {
          await shutdownAndDisposeChildSession(untrustedSession);
        }

        const trusted = await createChildResources({ cwd, agentDir, projectTrusted: true });
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          resourceLoader: trusted.loader,
          settingsManager: trusted.settingsManager,
          sessionManager: SessionManager.inMemory(cwd),
          ...childToolPolicy(),
        });
        try {
          await bindChildSessionExtensions(session);
          await session.prompt("/mcp reconnect fixture");
          assert.equal(
            session.getAllTools().some((tool) => tool.name === "mcp__fixture__echo"),
            true,
          );
          assert.equal(session.getActiveToolNames().includes("codemode"), true);
          // Activate the deferred tool directly so the test needs no model request.
          session.setActiveToolsByName([...session.getActiveToolNames(), "mcp__fixture__echo"]);
          const tool = session.agent.state.tools.find((tool) => tool.name === "mcp__fixture__echo");
          assert.ok(tool);
          const result = await tool.execute("fixture-call", {});
          const output = result.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          assert.match(output, /native MCP fixture/);
        } finally {
          await shutdownAndDisposeChildSession(session);
        }
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    });
  },
);

test("child resources honor disabled native MCP and discovery extensions", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search"],
      }),
    );
    const { loader } = await createChildResources({
      cwd: directory,
      agentDir,
      projectTrusted: false,
    });
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(
      extensions.some((extension) => extension.path.startsWith("builtin:")),
      false,
    );
  });
});

test("alternate standalone cwd only uses explicit saved trust", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const childCwd = path.join(directory, "alternate");
    const agentDir = path.join(directory, "agent");
    await mkdir(parentCwd, { recursive: true });
    await mkdir(childCwd, { recursive: true });

    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd: parentCwd,
        parentTrusted: true,
        agentDir,
      }),
      true,
    );
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: true,
        agentDir,
      }),
      false,
    );

    new ProjectTrustStore(agentDir).set(childCwd, true);
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: false,
        agentDir,
      }),
      true,
    );
  });
});

test("shutdown helper balances hooks and disposal despite errors", async () => {
  let emits = 0;
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      async emit(event: SessionShutdownEvent) {
        emits++;
        assert.deepEqual(event, { type: "session_shutdown", reason: "quit" });
        throw new Error("fixture shutdown failure");
      },
    },
    dispose() {
      disposals++;
    },
  };

  await Promise.all([
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
  ]);
  assert.equal(emits, 1);
  assert.equal(disposals, 1);
});

test("shutdown helper bounds a stuck hook before disposal", async () => {
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      emit: () => new Promise<void>(() => {}),
    },
    dispose() {
      disposals++;
    },
  };

  await shutdownAndDisposeChildSession(session, { timeoutMs: 10 });
  assert.equal(disposals, 1);
});
