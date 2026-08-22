import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { persistWorkflowJson } from "./artifacts.ts";
import { emptyUsage, type WorkflowDetails } from "./model.ts";
import {
  parseStoredRunSummary,
  parseStoredTranscript,
  parseStoredTranscripts,
  parseStoredWorkflow,
} from "./stored.ts";

function completedWorkflowDetails(): WorkflowDetails {
  return {
    runId: "wf_fixture",
    sessionId: "session_fixture",
    name: "Stored round trip",
    description: "Exercises the complete persisted workflow surface",
    background: true,
    status: "completed",
    startedAt: 1_000,
    finishedAt: 2_000,
    currentPhase: "Verify",
    phases: [{ title: "Build", detail: "Create the fixture" }, { title: "Verify" }],
    error: "completed with a recorded warning",
    result: { verdict: "ok", counts: [1, 2] },
    agents: [
      {
        index: 1,
        label: "builder",
        phase: "Build",
        state: "done",
        model: "fixture/model",
        contextWindow: 128_000,
        startedAt: 1_100,
        finishedAt: 1_500,
        preview: "fixture built",
        usage: {
          input: 101,
          output: 202,
          cacheRead: 303,
          cacheWrite: 404,
          cost: 0.0123,
          contextTokens: 505,
          turns: 6,
        },
        transcript: [
          { role: "user", text: "Build the fixture" },
          { role: "assistant", text: "I will build it" },
          {
            role: "tool",
            name: "fixture_tool",
            toolCallId: "call_fixture",
            text: '{"value":1}',
            startedAt: 1_200,
            finishedAt: 1_225,
            durationMs: 25,
          },
        ],
      },
      {
        index: 2,
        label: "reviewer",
        phase: "Verify",
        state: "error",
        startedAt: 1_600,
        finishedAt: 1_900,
        error: "fixture review failed",
        preview: "review failed",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
  };
}

test("stored workflow round-trips artifacts written to real files", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-stored-"));
  try {
    const details = completedWorkflowDetails();
    persistWorkflowJson(directory, details);

    const workflowJson = JSON.parse(readFileSync(join(directory, "workflow.json"), "utf8"));
    const transcriptsJson = JSON.parse(readFileSync(join(directory, "transcripts.json"), "utf8"));
    const resultJson = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    const stored = parseStoredWorkflow("wf_fixture", workflowJson);
    const transcripts = parseStoredTranscripts(transcriptsJson);

    assert.ok(stored, "writer output must remain readable so the run does not vanish");
    assert.equal(stored.sessionId, details.sessionId);
    assert.equal(stored.name, details.name);
    assert.equal(stored.status, details.status);
    assert.equal(stored.background, details.background);
    assert.equal(stored.startedAt, details.startedAt);
    assert.equal(stored.finishedAt, details.finishedAt);
    assert.deepEqual(stored.phases, details.phases);
    assert.equal(stored.error, details.error);
    assert.equal(stored.resultArtifact, "result.json");
    assert.equal(stored.transcriptArtifact, "transcripts.json");

    assert.equal(stored.agents.length, 2);
    assert.equal(stored.agents[0]?.label, "builder");
    assert.equal(stored.agents[0]?.state, "done");
    assert.equal(stored.agents[0]?.model, "fixture/model");
    assert.equal(stored.agents[0]?.contextWindow, 128_000);
    assert.deepEqual(stored.agents[0]?.usage, details.agents[0]?.usage);
    assert.equal(stored.agents[1]?.label, "reviewer");
    assert.equal(stored.agents[1]?.state, "error");
    assert.equal(stored.agents[1]?.error, "fixture review failed");
    assert.deepEqual(stored.agents[1]?.usage, details.agents[1]?.usage);

    assert.equal(workflowJson.result, "[stored in result.json]");
    assert.deepEqual(resultJson, details.result);

    const builderTranscript = transcripts.get("1");
    assert.ok(builderTranscript);
    assert.deepEqual(
      builderTranscript.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "Build the fixture" },
        { role: "assistant", text: "I will build it" },
        { role: "tool", text: '{"value":1}' },
      ],
    );
    const storedToolEntry = builderTranscript[2];
    assert.equal(storedToolEntry?.name, "fixture_tool");
    // Characterization, not endorsement: stored.ts currently drops persisted tool timing metadata.
    assert.equal(storedToolEntry?.toolCallId, undefined);
    assert.equal(storedToolEntry?.startedAt, undefined);
    assert.equal(storedToolEntry?.finishedAt, undefined);
    assert.equal(storedToolEntry?.durationMs, undefined);
    assert.deepEqual(transcripts.get("2"), []);

    const summary = parseStoredRunSummary(workflowJson);
    assert.ok(summary);
    assert.equal(summary.sessionId, details.sessionId);
    assert.equal(summary.status, details.status);
    assert.deepEqual(summary.agents, [{ state: "done" }, { state: "error" }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stored workflow decoder preserves interrupted running state", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-running-"));
  try {
    const details: WorkflowDetails = {
      runId: "wf_running",
      sessionId: "session_running",
      background: true,
      status: "running",
      startedAt: 3_000,
      phases: [],
      agents: [
        {
          index: 1,
          label: "active-agent",
          state: "running",
          startedAt: 3_100,
          preview: "still working",
          usage: emptyUsage(),
          transcript: [],
        },
      ],
    };
    persistWorkflowJson(directory, details);

    const workflowJson = JSON.parse(readFileSync(join(directory, "workflow.json"), "utf8"));
    const stored = parseStoredWorkflow("wf_running", workflowJson);

    assert.ok(stored);
    // Callers downgrade stale state: listRuns maps the run to aborted, while loadRunEntries
    // rewrites running agents to error. The decoder stays faithful so the downgrade is not done twice.
    assert.equal(stored.status, "running");
    assert.equal(stored.agents[0]?.state, "running");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stored decoders tolerate degraded records and discard unusable members", () => {
  const stored = parseStoredWorkflow("wf_degraded", {
    startedAt: "yesterday",
    background: "yes",
    agents: [
      null,
      {
        index: 2,
        label: "legacy-agent",
        state: "failed",
        contextWindow: -5,
        error: "[undefined]",
      },
    ],
  });

  assert.ok(stored);
  assert.equal(stored.startedAt, 0);
  assert.equal(stored.background, false);
  assert.equal(stored.status, "completed");
  assert.equal(stored.agents.length, 1);
  assert.equal(stored.agents[0]?.state, "error");
  assert.equal(stored.agents[0]?.contextWindow, undefined);
  assert.equal(stored.agents[0]?.error, undefined);
  assert.equal(parseStoredWorkflow("wf_invalid", 42), undefined);

  const transcript = parseStoredTranscript([
    null,
    42,
    { role: "assistant", text: "kept" },
    { role: "assistant", text: 99 },
    "garbage",
    { role: "toolResult", text: "also kept", isError: true },
  ]);
  assert.deepEqual(
    transcript.map(({ role, text, isError }) => ({ role, text, isError })),
    [
      { role: "assistant", text: "kept", isError: false },
      { role: "toolResult", text: "also kept", isError: true },
    ],
  );
});
