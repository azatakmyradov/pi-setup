import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubagentSendResult,
  buildSubagentSpawnResult,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

test("Claude model guidance preserves explicitly requested versions", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");

  assert.match(guidance, /exact full identifier/);
  assert.match(guidance, /claude-opus-4-8/);
  assert.match(guidance, /not "opus"/);

  const modelDescription = SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model;
  assert.match(modelDescription, /claude-opus-4-8/);
  assert.match(modelDescription, /latest version is intended/);
  assert.match(modelDescription, /Preserve any model\/version.*exactly/);
});

test("spawn guidance warns about autonomous working-directory trust", () => {
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /normal host permissions/);
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /trusted working directories/);
  assert.match(SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir, /Trusted working directory/);
});

test("spawn guidance discourages polling and duplicating the child's work", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");

  assert.match(guidance, /Never poll subagent_check in a loop/);
  assert.match(guidance, /do not edit the files it is working on/);
  assert.match(guidance, /use subagent_send instead of spawning a new one/);

  const spawnResult = buildSubagentSpawnResult({
    id: "sa-1",
    title: "map the manager",
    agent: "explore",
    harness: "pi",
    modelLabel: "test-model",
    cwd: "/tmp/project",
  });
  assert.match(spawnResult, /Do not poll subagent_check in a loop/);
  assert.match(spawnResult, /do not edit the files it is working on/);
  assert.match(spawnResult, /subagent_send\(id: "sa-1"\)/);
});

test("send results distinguish steering, queueing, and restarting", () => {
  const base = { id: "sa-2", title: "review diff" };

  assert.match(
    buildSubagentSendResult({ ...base, running: true, steering: true }),
    /^Steering sa-2 "review diff"/,
  );
  assert.match(
    buildSubagentSendResult({ ...base, running: true, steering: false }),
    /^Queued for sa-2's next turn \(this harness cannot steer mid-run\)/,
  );
  assert.match(
    buildSubagentSendResult({ ...base, running: false, steering: true }),
    /^Restarted sa-2 "review diff" with a follow-up; it keeps its full prior context\./,
  );
});
