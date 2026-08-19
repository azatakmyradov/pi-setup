import assert from "node:assert/strict";
import test from "node:test";
import {
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
