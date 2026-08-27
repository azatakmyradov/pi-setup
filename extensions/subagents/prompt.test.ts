import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubagentSendResult,
  buildSubagentSpawnResult,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import * as prompt from "./src/prompt.ts";

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

test("spawn guidance teaches parallel foreground fan-out", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");

  assert.match(guidance, /several subagent_spawn calls in a single message/);
  assert.match(guidance, /Foreground is the default/);
  assert.match(guidance, /Use background: true only for work you genuinely do not need right now/);
});

test("the spawn tool description documents queueing rather than failure", () => {
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /blocks until the subagent finishes/);
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /extra spawns are queued/);
  assert.match(
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    /multiple subagent_spawn calls in a single message/,
  );
});

test("no model-facing prompt string mentions the removed subagent_wait tool", () => {
  // JSON.stringify walks every exported constant — plain strings, the guideline
  // array, and the parameter-description records. The result builders carry
  // their own wording assertions below.
  assert.doesNotMatch(JSON.stringify(prompt), /subagent_wait/);
  assert.doesNotMatch(
    buildSubagentSendResult({ id: "sa-1", title: "t", running: false, steering: true }),
    /subagent_wait/,
  );
  assert.doesNotMatch(
    buildSubagentSpawnResult({
      id: "sa-1",
      title: "t",
      agent: "general",
      harness: "pi",
      modelLabel: "test-model",
      cwd: "/tmp/project",
      background: true,
    }),
    /subagent_wait/,
  );
});

test("spawn guidance discourages polling and duplicating the child's work", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");

  assert.match(guidance, /never poll subagent_check in a loop/);
  assert.match(guidance, /do not edit the files it is working on/);
  assert.match(guidance, /use subagent_send instead of spawning a new one/);

  // The anti-poll wording belongs to the spawn that leaves a child running
  // without this call waiting for it.
  const spawnResult = buildSubagentSpawnResult({
    id: "sa-1",
    title: "map the manager",
    agent: "explore",
    harness: "pi",
    modelLabel: "test-model",
    cwd: "/tmp/project",
    background: true,
  });
  assert.match(spawnResult, /Do not sleep, do not poll subagent_check in a loop/);
  assert.match(spawnResult, /do not edit the files it is working on/);
  assert.match(spawnResult, /subagent_send\(id: "sa-1"\)/);
});

test("the send tool description documents steering and the blocking restart", () => {
  const description = prompt.SUBAGENT_SEND_TOOL_DESCRIPTION;

  assert.match(description, /steered mid-run .* and the call returns immediately/);
  assert.match(description, /blocks until the restarted run finishes and returns its output/);
  assert.match(description, /`background: true` to return immediately/);
  assert.match(
    prompt.SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.background,
    /^Only applies when the subagent has already finished and this restarts it\. Default false/,
  );
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
  // Only a background restart uses this builder; a blocking one returns the
  // restarted run's sections instead.
  const restarted = buildSubagentSendResult({ ...base, running: false, steering: true });
  assert.match(
    restarted,
    /^Restarted sa-2 "review diff" with a follow-up; it keeps its full prior context\./,
  );
  assert.match(restarted, /delivered to you as a message after you end your turn/);
  assert.match(restarted, /Do not sleep, do not poll subagent_check in a loop/);
  assert.match(
    buildSubagentSendResult({ ...base, running: true, steering: true }),
    /Its result arrives as a message when the run settles\./,
  );
});
