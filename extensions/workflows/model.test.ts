import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, phaseState, type AgentRecord, type WorkflowDetails } from "./model.ts";

function makeAgent(overrides: Partial<AgentRecord> & Pick<AgentRecord, "phase">): AgentRecord {
  return {
    index: 1,
    label: "agent-1",
    state: "done",
    startedAt: 1_000,
    preview: "",
    usage: emptyUsage(),
    transcript: [],
    ...overrides,
  };
}

function makeDetails(overrides: Partial<WorkflowDetails>): WorkflowDetails {
  return {
    runId: "wf_fixture",
    background: false,
    status: "running",
    startedAt: 1_000,
    phases: [{ title: "RED" }, { title: "GREEN" }, { title: "REFACTOR" }],
    agents: [],
    ...overrides,
  };
}

test("phaseState tracks phase progression during a run", () => {
  const details = makeDetails({ currentPhase: "GREEN" });
  assert.equal(phaseState(details, "RED"), "success");
  assert.equal(phaseState(details, "GREEN"), "running");
  assert.equal(phaseState(details, "REFACTOR"), "pending");
});

test("phaseState lets agent states override progression", () => {
  const details = makeDetails({
    currentPhase: "REFACTOR",
    agents: [
      makeAgent({ phase: "RED", state: "error" }),
      makeAgent({ index: 2, label: "agent-2", phase: "GREEN", state: "running" }),
    ],
  });
  assert.equal(phaseState(details, "RED"), "error");
  assert.equal(phaseState(details, "GREEN"), "running");
  assert.equal(phaseState(details, "REFACTOR"), "running");
});

test("phaseState mirrors the final run status on the current phase", () => {
  const completed = makeDetails({ status: "completed", currentPhase: "REFACTOR" });
  assert.equal(phaseState(completed, "REFACTOR"), "success");

  const failed = makeDetails({ status: "failed", currentPhase: "GREEN" });
  assert.equal(phaseState(failed, "GREEN"), "error");
  assert.equal(phaseState(failed, "REFACTOR"), "pending");
});

test("phaseState falls back to agent states when phase() was never called", () => {
  const details = makeDetails({
    agents: [makeAgent({ phase: "RED", state: "done" })],
  });
  assert.equal(phaseState(details, "RED"), "success");
  assert.equal(phaseState(details, "GREEN"), "pending");
});
