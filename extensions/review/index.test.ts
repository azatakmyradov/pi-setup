import assert from "node:assert/strict";
import test from "node:test";
import {
  appendReviewSchemaInstruction,
  createReviewResultDelivery,
  formatReviewOutput,
  parseReviewOutput,
  REVIEW_SCHEMA,
  type ReviewMessageHost,
  type ReviewOutput,
  type ReviewResultSnapshot,
} from "./index.ts";

type SendMessageArguments = Parameters<ReviewMessageHost["sendMessage"]>;

interface SentMessage {
  message: SendMessageArguments[0];
  options: SendMessageArguments[1];
}

function reviewSnapshot(id = "sa-review"): ReviewResultSnapshot {
  return {
    id,
    status: "done",
    finalText: JSON.stringify(output),
  };
}

function deliveryHarness(isIdle: () => boolean) {
  const sent: SentMessage[] = [];
  const pi: ReviewMessageHost = {
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
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
  assert.deepEqual(parseReviewOutput(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``), output);
});

test("review output parsing rejects invalid structured results", () => {
  assert.throws(() => parseReviewOutput('{"findings":[]}'), /invalid structured result/);
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
  assert.equal(sent[0]?.message.customType, "code-review-result");

  delivery.flush();
  assert.equal(sent.length, 1);
});

test("consumed review settlements are not delivered", () => {
  const { sent, delivery } = deliveryHarness(() => true);

  delivery.settle(reviewSnapshot(), true);
  delivery.flush();

  assert.equal(sent.length, 0);
});
