import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRunArtifacts } from "./dashboard.ts";

test("decodeRunArtifacts attaches stored results and indexed transcripts", () => {
  const details = decodeRunArtifacts(
    "wf_fixture",
    {
      sessionId: "session_fixture",
      status: "completed",
      startedAt: 1_000,
      agents: [
        { index: 4, label: "fourth", state: "done", startedAt: 1_100 },
        { index: 9, label: "ninth", state: "done", startedAt: 1_200 },
      ],
      result: "[stored in result.json]",
      resultArtifact: "result.json",
      transcriptArtifact: "transcripts.json",
    },
    { answer: 42 },
    {
      "4": [{ role: "assistant", text: "fourth transcript" }],
      "9": [{ role: "toolResult", name: "lookup", text: "ninth transcript" }],
    },
  );

  assert.ok(details);
  assert.deepEqual(details.result, { answer: 42 });
  assert.equal(details.agents[0]?.transcript[0]?.text, "fourth transcript");
  assert.equal(details.agents[1]?.transcript[0]?.text, "ninth transcript");
  assert.equal(details.agents[1]?.transcript[0]?.name, "lookup");
});

test("decodeRunArtifacts downgrades stale running workflow and agent state", () => {
  const details = decodeRunArtifacts(
    "wf_stale",
    {
      status: "running",
      startedAt: 2_000,
      agents: [
        { index: 1, label: "running", state: "running", startedAt: 2_100 },
        { index: 2, label: "settled", state: "done", startedAt: 2_200, finishedAt: 2_300 },
      ],
    },
    undefined,
    undefined,
    3_000,
  );

  assert.ok(details);
  assert.equal(details.status, "aborted");
  assert.equal(details.finishedAt, 3_000);
  assert.equal(details.error, "Recovered stale run that was not active");
  assert.equal(details.agents[0]?.state, "error");
  assert.equal(details.agents[0]?.finishedAt, 3_000);
  assert.equal(details.agents[0]?.error, "Run ended before this agent settled");
  assert.equal(details.agents[1]?.state, "done");
  assert.equal(details.agents[1]?.finishedAt, 2_300);
});

test("decodeRunArtifacts reduces doctored artifact pointers to basenames", () => {
  const details = decodeRunArtifacts("wf_doctored", {
    status: "completed",
    startedAt: 1,
    agents: [],
    resultArtifact: "../../outside/result.json",
    transcriptArtifact: "../outside/transcripts.json",
  });

  assert.ok(details);
  assert.equal(details.resultArtifact, "result.json");
  assert.equal(details.transcriptArtifact, "transcripts.json");
});
