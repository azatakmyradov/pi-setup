import assert from "node:assert/strict";
import test from "node:test";
import type {
  TrackedSubagentHost,
  TrackedSubagentSpawnRequest,
} from "../shared/tracked-subagent.ts";
import type { ReviewOutput } from "../review/index.ts";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";
import {
  buildReviewPrompt,
  buildVerificationPrompt,
  parseVerificationOutput,
  runReviewFixLoop,
  type VerificationOutput,
} from "./index.ts";

const finding = {
  title: "[P1] Preserve the result",
  body: "The new path drops the result before it can be consumed.",
  confidence_score: 0.98,
  priority: 1,
  code_location: {
    absolute_file_path: "/repo/src/result.ts",
    line_range: { start: 10, end: 11 },
  },
};

function review(findings = [finding]): ReviewOutput {
  return {
    findings,
    overall_correctness:
      findings.length === 0 ? "patch is correct" : "patch is incorrect",
    overall_explanation:
      findings.length === 0 ? "No issues found." : "The result can be lost.",
    overall_confidence_score: 0.95,
  };
}

function verification(verdict: "confirmed" | "rejected"): VerificationOutput {
  return {
    verdicts: [
      {
        finding_index: 0,
        verdict,
        explanation:
          verdict === "confirmed"
            ? "The changed branch demonstrably drops the value."
            : "The caller intentionally ignores this optional result.",
      },
    ],
    overall_explanation: "Checked against the current diff and call sites.",
  };
}

function snapshot(
  id: string,
  backend: "pi" | "claude",
  finalText: string,
  status: "done" | "error" = "done",
  errorText?: string,
): SubagentSnapshot {
  return {
    id,
    backend,
    title: id,
    prompt: "",
    cwd: "/repo",
    status,
    createdAt: Date.now(),
    errorText,
    meta: { backend },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText,
    turns: 1,
  };
}

type FakeOutput =
  string | { text?: string; status: "error"; errorText: string };

function hostWithOutputs(outputs: FakeOutput[]) {
  const requests: TrackedSubagentSpawnRequest[] = [];
  const host: TrackedSubagentHost = {
    async list() {
      return [];
    },
    async cancel() {},
    async spawn(request) {
      requests.push(request);
      const index = requests.length - 1;
      const backend = request.backend === "claude" ? "claude" : "pi";
      const output = outputs[index] ?? "";
      const settled =
        typeof output === "string"
          ? snapshot(`sa-${index + 1}`, backend, output)
          : snapshot(
              `sa-${index + 1}`,
              backend,
              output.text ?? "",
              output.status,
              output.errorText,
            );
      queueMicrotask(() => request.onSettled?.(settled, false));
      return { ...settled, status: "running", finalText: "" };
    },
  };
  return { host, requests };
}

const parent = {
  parentCwd: "/repo",
  projectTrusted: true,
};

test("verification output requires exactly one verdict per finding", () => {
  assert.deepEqual(
    parseVerificationOutput(JSON.stringify(verification("confirmed")), 1),
    verification("confirmed"),
  );
  assert.throws(
    () =>
      parseVerificationOutput('{"verdicts":[],"overall_explanation":""}', 1),
    /exactly one verdict/,
  );
  assert.throws(
    () =>
      parseVerificationOutput(
        '{"verdicts":[{"finding_index":0,"verdict":"maybe","explanation":"x"}],"overall_explanation":""}',
        1,
      ),
    /invalid structured result/,
  );
});

test("prompts enforce uncommitted review scope and read-only verification", () => {
  const reviewPrompt = buildReviewPrompt(
    "Focus on cancellation.",
    [],
    "$ git status --short\n M src/result.ts",
  );
  assert.match(reviewPrompt, /captured Git status/i);
  assert.match(reviewPrompt, /M src\/result\.ts/);
  assert.match(reviewPrompt, /Focus on cancellation/);
  assert.match(reviewPrompt, /no mutation-capable tools/i);

  const verifierPrompt = buildVerificationPrompt(review());
  assert.match(verifierPrompt, /strictly read-only/);
  assert.match(verifierPrompt, /exactly one verdict for every finding index/i);
  assert.match(verifierPrompt, /Preserve the result/);
});

test("a clean first review stops without verification or fixing", async () => {
  const { host, requests } = hostWithOutputs([JSON.stringify(review([]))]);

  const outcome = await runReviewFixLoop({ host, cwd: "/repo", parent });

  assert.equal(outcome.status, "clean");
  assert.equal(outcome.iterations, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.backend, "pi");
  assert.equal(requests[0]?.model, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(requests[0]?.tools, ["read", "grep", "find", "ls"]);
});

test("force-stopping an active review returns stopped instead of failed", async () => {
  let activeRequest: TrackedSubagentSpawnRequest | undefined;
  let stop = false;
  const cancelled: string[] = [];
  const host: TrackedSubagentHost = {
    async list() {
      return [];
    },
    async spawn(request) {
      activeRequest = request;
      return {
        ...snapshot("sa-1", "pi", "", "error"),
        status: "running",
        errorText: undefined,
      };
    },
    async cancel(ids) {
      cancelled.push(...ids);
      activeRequest?.onSettled?.(
        snapshot("sa-1", "pi", "", "error", "Run was aborted"),
        true,
      );
    },
  };

  const outcome = await runReviewFixLoop({
    host,
    cwd: "/repo",
    parent,
    shouldStop: () => stop,
    onStageStarted: ({ snapshot: started }) => {
      stop = true;
      void host.cancel([started.id]);
    },
  });

  assert.equal(outcome.status, "stopped");
  assert.equal(outcome.iterations, 0);
  assert.deepEqual(cancelled, ["sa-1"]);
});

test("confirmed findings are verified by Fable, fixed by Sol, then reviewed again", async () => {
  const { host, requests } = hostWithOutputs([
    JSON.stringify(review()),
    JSON.stringify(verification("confirmed")),
    "Implemented the focused fix and ran the relevant test.",
    JSON.stringify(review([])),
  ]);
  const stages: string[] = [];

  const outcome = await runReviewFixLoop({
    host,
    cwd: "/repo",
    parent,
    onStageStarted: ({ iteration, stage, snapshot }) => {
      stages.push(`${iteration}:${stage}:${snapshot.id}`);
    },
  });

  assert.equal(outcome.status, "clean");
  assert.deepEqual(stages, [
    "1:review:sa-1",
    "1:verify:sa-2",
    "1:fix:sa-3",
    "2:review:sa-4",
  ]);
  assert.equal(outcome.iterations, 2);
  assert.equal(outcome.fixPasses, 1);
  assert.deepEqual(
    requests.map(({ backend, model }) => `${backend}:${model}`),
    [
      "pi:openai-codex/gpt-5.6-sol",
      "claude:fable",
      "pi:openai-codex/gpt-5.6-sol",
      "pi:openai-codex/gpt-5.6-sol",
    ],
  );
  assert.deepEqual(requests[1]?.tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(requests[2]?.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
  ]);
});

test("fully rejected findings are fed back to the next review without running a fixer", async () => {
  const { host, requests } = hostWithOutputs([
    JSON.stringify(review()),
    JSON.stringify(verification("rejected")),
    JSON.stringify(review([])),
  ]);

  const outcome = await runReviewFixLoop({ host, cwd: "/repo", parent });

  assert.equal(outcome.status, "clean");
  assert.equal(outcome.fixPasses, 0);
  assert.deepEqual(
    requests.map(({ backend }) => backend),
    ["pi", "claude", "pi"],
  );
  assert.match(
    requests[2]?.prompt ?? "",
    /Findings rejected by the independent verifier/,
  );
  assert.match(requests[2]?.prompt ?? "", /caller intentionally ignores/);
});

test("the final review iteration never launches an unreviewed fixer", async () => {
  const { host, requests } = hostWithOutputs([
    JSON.stringify(review()),
    JSON.stringify(verification("confirmed")),
  ]);

  const outcome = await runReviewFixLoop({
    host,
    cwd: "/repo",
    parent,
    maxIterations: 1,
  });

  assert.equal(outcome.status, "max_iterations");
  assert.equal(outcome.fixPasses, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ backend }) => backend),
    ["pi", "claude"],
  );
});

test("stopping during a completed fixer skips the safety review", async () => {
  const { host, requests } = hostWithOutputs([
    JSON.stringify(review()),
    JSON.stringify(verification("confirmed")),
    "Implemented the fix.",
  ]);
  let stop = false;

  const outcome = await runReviewFixLoop({
    host,
    cwd: "/repo",
    parent,
    shouldStop: () => stop,
    onStageStarted: ({ stage }) => {
      if (stage === "fix") stop = true;
    },
  });

  assert.equal(outcome.status, "stopped");
  assert.equal(outcome.fixPasses, 1);
  assert.equal(requests.length, 3);
});

test("a failed fixer is followed by a safety review before the error escapes", async () => {
  const { host, requests } = hostWithOutputs([
    JSON.stringify(review()),
    JSON.stringify(verification("confirmed")),
    { status: "error", errorText: "edit failed after a partial write" },
    JSON.stringify(review([])),
  ]);

  await assert.rejects(
    runReviewFixLoop({ host, cwd: "/repo", parent }),
    /edit failed after a partial write[\s\S]*Safety review:[\s\S]*No issues found/,
  );
  assert.equal(requests.length, 4);
  assert.match(requests[3]?.title ?? "", /fixer safety review/);
});

test("the safety cap returns the final non-clean review", async () => {
  const { host, requests } = hostWithOutputs([
    JSON.stringify(review()),
    JSON.stringify(verification("rejected")),
    JSON.stringify(review()),
    JSON.stringify(verification("rejected")),
  ]);

  const outcome = await runReviewFixLoop({
    host,
    cwd: "/repo",
    parent,
    maxIterations: 2,
  });

  assert.equal(outcome.status, "max_iterations");
  assert.equal(outcome.iterations, 2);
  assert.equal(requests.length, 4);
});
