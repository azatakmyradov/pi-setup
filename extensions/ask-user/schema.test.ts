import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AskUserParams,
  MAX_OPTIONS,
  MAX_PREVIEW_LENGTH,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  prepareAskUserArguments,
  type AskUserQuestionType,
} from "./schema.ts";

const option = (index: number) => ({ label: `Option ${index}` });
const previewOption = (index: number, preview = `┌─ ${index} ─┐`) => ({
  label: `Layout ${index}`,
  preview,
});
const question = (
  index: number,
  type: AskUserQuestionType = "single",
  optionCount = MIN_OPTIONS,
) => ({
  label: `Question ${index}`,
  question: `Question ${index}?`,
  type,
  options: Array.from({ length: optionCount }, (_, optionIndex) =>
    option(optionIndex + 1),
  ),
});

describe("AskUserParams", () => {
  it("accepts single-select, multi-select, and preview questions", () => {
    expect(
      Check(AskUserParams, {
        questions: [
          question(1, "single"),
          question(2, "multiple"),
          {
            question: "Choose a layout",
            type: "preview",
            options: [previewOption(1), previewOption(2)],
          },
        ],
      }),
    ).toBe(true);
  });

  it("requires a non-empty, reasonably sized preview on every preview option", () => {
    const previewQuestion = {
      question: "Choose a layout",
      type: "preview",
      options: [previewOption(1), previewOption(2)],
    };

    expect(
      Check(AskUserParams, {
        questions: [
          {
            ...previewQuestion,
            options: [{ label: "Missing" }, previewOption(2)],
          },
        ],
      }),
    ).toBe(false);
    expect(
      Check(AskUserParams, {
        questions: [
          {
            ...previewQuestion,
            options: [previewOption(1, "  \n\t"), previewOption(2)],
          },
        ],
      }),
    ).toBe(false);
    expect(
      Check(AskUserParams, {
        questions: [
          {
            ...previewQuestion,
            options: [
              previewOption(1, "x".repeat(MAX_PREVIEW_LENGTH + 1)),
              previewOption(2),
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("requires an explicit valid question type in the public schema", () => {
    const { type: _type, ...withoutType } = question(1);
    expect(Check(AskUserParams, { questions: [withoutType] })).toBe(false);
    expect(
      Check(AskUserParams, {
        questions: [{ ...question(1), type: "anything" }],
      }),
    ).toBe(false);
  });

  it("accepts one through five questions", () => {
    expect(Check(AskUserParams, { questions: [question(1)] })).toBe(true);
    expect(
      Check(AskUserParams, {
        questions: Array.from({ length: MAX_QUESTIONS }, (_, index) =>
          question(index + 1),
        ),
      }),
    ).toBe(true);
  });

  it("rejects question batches outside the allowed range", () => {
    expect(Check(AskUserParams, { questions: [] })).toBe(false);
    expect(
      Check(AskUserParams, {
        questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, index) =>
          question(index + 1),
        ),
      }),
    ).toBe(false);
  });

  it("enforces the option count for every question", () => {
    expect(
      Check(AskUserParams, { questions: [question(1, "single", 1)] }),
    ).toBe(false);
    expect(
      Check(AskUserParams, {
        questions: [question(1, "multiple", MAX_OPTIONS + 1)],
      }),
    ).toBe(false);
  });
});

describe("prepareAskUserArguments", () => {
  it("converts the legacy single-question shape and defaults its type", () => {
    expect(
      prepareAskUserArguments({
        question: "Which scope?",
        options: [{ label: "Small" }, { label: "Large" }],
      }),
    ).toEqual({
      questions: [
        {
          question: "Which scope?",
          type: "single",
          options: [{ label: "Small" }, { label: "Large" }],
        },
      ],
    });
  });

  it("defaults missing types in the batched shape to single", () => {
    expect(
      prepareAskUserArguments({
        questions: [
          {
            question: "Which scope?",
            options: [{ label: "Small" }, { label: "Large" }],
          },
          question(2, "multiple"),
        ],
      }),
    ).toMatchObject({
      questions: [{ type: "single" }, { type: "multiple" }],
    });
  });

  it("leaves the current shape unchanged", () => {
    const input = { questions: [question(1)] };
    expect(prepareAskUserArguments(input)).toBe(input);
  });
});
