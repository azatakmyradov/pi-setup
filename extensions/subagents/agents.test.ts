/**
 * Agent-definition loading: built-ins, file precedence, trust gating, and the
 * model-facing roster. Definitions come from real files in a temp directory,
 * which is the only part of the pipeline that can differ from production.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildAgentRoster,
  DEFAULT_AGENT_NAME,
  loadAgentDefinitions,
  resolveSpawnAgent,
  type AgentDefinitions,
} from "./src/agents.ts";

interface Workspace {
  readonly agentDir: string;
  readonly cwd: string;
}

/** A temp global agent dir + project cwd, cleaned up when the test ends. */
function workspace(t: { after(fn: () => void): void }): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-agents-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  return { agentDir, cwd };
}

function writeGlobal(ws: Workspace, name: string, content: string) {
  fs.writeFileSync(path.join(ws.agentDir, "agents", `${name}.md`), content);
}

function writeProject(ws: Workspace, name: string, content: string) {
  fs.writeFileSync(path.join(ws.cwd, ".pi", "agents", `${name}.md`), content);
}

function load(ws: Workspace, projectTrusted = true) {
  return loadAgentDefinitions({
    agentDir: ws.agentDir,
    cwd: ws.cwd,
    projectTrusted,
  });
}

test("built-in agents are always available", (t) => {
  const ws = workspace(t);
  const { agents, warnings } = load(ws);

  assert.deepEqual(warnings, []);
  const general = agents.get(DEFAULT_AGENT_NAME);
  assert.equal(general?.name, "general");
  // The default must stay identical to today's unrestricted spawn.
  assert.equal(general?.tools, undefined);
  assert.equal(general?.prompt, undefined);
  assert.equal(general?.harness, undefined);

  const explore = agents.get("explore");
  assert.deepEqual(explore?.tools, ["read", "grep", "find", "ls", "bash"]);
  assert.match(explore?.prompt ?? "", /read-only/);
  assert.match(explore?.prompt ?? "", /very thorough/);
  assert.match(explore?.prompt ?? "", /absolute paths/);
});

test("a global definition file becomes a spawnable agent", (t) => {
  const ws = workspace(t);
  writeGlobal(
    ws,
    "auditor",
    [
      "---",
      "description: Security auditor",
      "harness: claude",
      "model: claude-opus-4-8",
      "reasoning_effort: high",
      "tools: [read, grep, read]",
      "---",
      "",
      "Audit the diff and report findings.",
      "",
    ].join("\n"),
  );

  const { agents, warnings } = load(ws);
  assert.deepEqual(warnings, []);
  assert.deepEqual(agents.get("auditor"), {
    name: "auditor",
    description: "Security auditor",
    prompt: "Audit the diff and report findings.",
    harness: "claude",
    model: "claude-opus-4-8",
    reasoningEffort: "high",
    tools: ["read", "grep"],
  });
});

test("a user definition overrides a built-in of the same name", (t) => {
  const ws = workspace(t);
  writeGlobal(
    ws,
    "explore",
    ["---", "description: My explorer", "tools: [read]", "---", "Search only.", ""].join("\n"),
  );

  const { agents } = load(ws);
  assert.equal(agents.get("explore")?.description, "My explorer");
  assert.deepEqual(agents.get("explore")?.tools, ["read"]);
  // Overriding keeps the built-in roster position.
  assert.deepEqual([...agents.keys()], ["general", "explore"]);
});

test("a project definition overrides a global one of the same name", (t) => {
  const ws = workspace(t);
  writeGlobal(ws, "helper", ["---", "description: Global helper", "---", ""].join("\n"));
  writeProject(ws, "helper", ["---", "description: Project helper", "---", ""].join("\n"));

  assert.equal(load(ws).agents.get("helper")?.description, "Project helper");
});

test("project definitions are ignored when the project is untrusted", (t) => {
  const ws = workspace(t);
  writeProject(ws, "sneaky", ["---", "description: Project only", "---", ""].join("\n"));

  assert.equal(load(ws, true).agents.has("sneaky"), true);
  assert.equal(load(ws, false).agents.has("sneaky"), false);
  assert.deepEqual(load(ws, false).warnings, []);
});

test("malformed definitions are skipped with a warning instead of throwing", (t) => {
  const ws = workspace(t);
  writeGlobal(ws, "broken-yaml", ["---", "description: [unclosed", "---", "body", ""].join("\n"));
  writeGlobal(ws, "bad-field", ["---", "description: ok", "harness: rust", "---", ""].join("\n"));
  writeGlobal(ws, "no-description", ["---", "model: gpt-5.6-sol", "---", "body", ""].join("\n"));
  writeGlobal(ws, "fine", ["---", "description: Works", "---", ""].join("\n"));

  const { agents, warnings } = load(ws);
  assert.equal(agents.has("broken-yaml"), false);
  assert.equal(agents.has("bad-field"), false);
  assert.equal(agents.has("no-description"), false);
  assert.equal(agents.has("fine"), true);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join("\n"), /broken-yaml\.md: could not read agent definition/);
  assert.match(warnings.join("\n"), /bad-field\.md: invalid frontmatter/);
  assert.match(warnings.join("\n"), /no-description\.md: missing required frontmatter field/);
});

test("disable removes an agent from the roster", (t) => {
  const ws = workspace(t);
  writeGlobal(ws, "explore", ["---", "disable: true", "---", ""].join("\n"));
  writeGlobal(ws, "temporary", ["---", "description: Temp", "---", ""].join("\n"));
  writeProject(ws, "temporary", ["---", "disable: true", "---", ""].join("\n"));

  const { agents, warnings } = load(ws);
  assert.deepEqual(warnings, []);
  assert.deepEqual([...agents.keys()], ["general"]);
});

test("the roster lists visible agents and omits hidden ones", (t) => {
  const ws = workspace(t);
  writeGlobal(ws, "secret", ["---", "description: Internal", "hidden: true", "---", ""].join("\n"));
  writeGlobal(ws, "shown", ["---", "description: Listed agent", "---", ""].join("\n"));

  const { agents } = load(ws);
  const roster = buildAgentRoster(agents);
  const lines = roster.split("\n");
  assert.equal(lines[0], "Available agents:");
  assert.equal(
    lines.some((line) => line.startsWith("- shown: Listed agent")),
    true,
  );
  assert.equal(roster.includes("secret"), false);
  // Hidden agents stay spawnable by name.
  assert.equal(resolveSpawnAgent(agents, "secret").name, "secret");
});

test("resolveSpawnAgent defaults to general and reports unknown names", () => {
  const agents: AgentDefinitions = new Map([
    ["general", { name: "general", description: "Default" }],
    ["explore", { name: "explore", description: "Search" }],
  ]);

  assert.equal(resolveSpawnAgent(agents, undefined).name, "general");
  assert.equal(resolveSpawnAgent(agents, "  ").name, "general");
  assert.equal(resolveSpawnAgent(agents, " explore ").name, "explore");
  assert.throws(
    () => resolveSpawnAgent(agents, "reviewer"),
    /Unknown agent "reviewer"\. Known agents: general, explore\./,
  );
});
