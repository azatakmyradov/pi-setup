import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";
import {
  appendReviewSchemaInstruction,
  createReviewResultDelivery,
  formatReviewOutput,
  parseReviewOutput,
  REVIEW_SCHEMA,
  type ReviewOutput,
} from "./index.ts";

interface SentMessage {
  message: unknown;
  options: unknown;
}

function reviewSnapshot(id = "sa-review"): SubagentSnapshot {
  return {
    id,
    status: "done",
    finalText: JSON.stringify(output),
  } as unknown as SubagentSnapshot;
}

function deliveryHarness(isIdle: () => boolean) {
  const sent: SentMessage[] = [];
  const pi = {
    sendMessage(message: unknown, options?: unknown) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  return { sent, delivery: createReviewResultDelivery(pi, isIdle) };
}

const output: ReviewOutput = {
  findings: [
    {
      title: "[P1] Preserve the tracked result",
      body: "The result is dropped when the background reviewer settles.",
      confidence_score: 0.98,
      priority: 1,
      code_location: {
        absolute_file_path: "/repo/extensions/review/index.ts",
        line_range: { start: 10, end: 11 },
      },
    },
  ],
  overall_correctness: "patch is incorrect",
  overall_explanation: "The background result is not delivered.",
  overall_confidence_score: 0.95,
};

test("review prompts include the complete structured-output schema", () => {
  const prompt = appendReviewSchemaInstruction("Review the current changes.");
  assert.match(prompt, /Respond with ONLY one JSON object/);
  assert.ok(prompt.includes(JSON.stringify(REVIEW_SCHEMA)));
});

test("review output parsing accepts raw and fenced JSON", () => {
  assert.deepEqual(parseReviewOutput(JSON.stringify(output)), output);
  assert.deepEqual(
    parseReviewOutput(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``),
    output,
  );
});

test("review output parsing rejects invalid structured results", () => {
  assert.throws(
    () => parseReviewOutput('{"findings":[]}'),
    /invalid structured result/,
  );
});

test("review formatting preserves the summary and findings", () => {
  const text = formatReviewOutput(output);
  assert.match(text, /The background result is not delivered/);
  assert.match(text, /\[P1\] Preserve the tracked result/);
  assert.match(text, /\/repo\/extensions\/review\/index\.ts:10-11/);
});

test("review results wait for parent idle and append without triggering a turn", () => {
  let idle = false;
  const { sent, delivery } = deliveryHarness(() => idle);

  delivery.settle(reviewSnapshot(), false);
  assert.equal(sent.length, 0);

  idle = true;
  delivery.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options, { triggerTurn: false });
  assert.equal(
    (sent[0]?.message as { customType?: unknown }).customType,
    "code-review-result",
  );

  delivery.flush();
  assert.equal(sent.length, 1);
});

test("consumed review settlements are not delivered", () => {
  const { sent, delivery } = deliveryHarness(() => true);

  delivery.settle(reviewSnapshot(), true);
  delivery.flush();

  assert.equal(sent.length, 0);
});
