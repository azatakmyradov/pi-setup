import { describe, expect, it } from "vitest";
import {
  getActiveQuestionIndices,
  validateQuestionConditions,
} from "./conditions.ts";
import type { AskUserInput } from "./schema.ts";

function conditionalQuestions(): AskUserInput["questions"] {
  return [
    {
      question: "Choose a target",
      type: "single",
      options: [{ label: "Work order" }, { label: "Option" }],
    },
    {
      question: "Configure work orders",
      type: "single",
      showWhen: { questionIndex: 1, selectedOptionIndices: [1] },
      options: [{ label: "Eligible" }, { label: "All" }],
    },
    {
      question: "Choose option behavior",
      type: "single",
      showWhen: { questionIndex: 1, selectedOptionIndices: [2] },
      options: [{ label: "Label" }, { label: "Code" }],
    },
  ];
}

const unanswered = () => ({ selections: [] });
const selected = (...selectedIndices: number[]) => ({
  selections: selectedIndices.map((selectedIndex) => ({
    selectedIndex,
    wasCustom: false,
  })),
});

describe("question conditions", () => {
  it("shows only roots until a listed parent option is selected", () => {
    const questions = conditionalQuestions();
    expect(
      getActiveQuestionIndices(questions, [
        unanswered(),
        unanswered(),
        unanswered(),
      ]),
    ).toEqual([0]);
    expect(
      getActiveQuestionIndices(questions, [
        selected(1),
        unanswered(),
        unanswered(),
      ]),
    ).toEqual([0, 1]);
    expect(
      getActiveQuestionIndices(questions, [
        selected(2),
        unanswered(),
        unanswered(),
      ]),
    ).toEqual([0, 2]);
  });

  it("matches any configured option for multi-select parents", () => {
    const questions = conditionalQuestions();
    questions[1]!.showWhen = {
      questionIndex: 1,
      selectedOptionIndices: [1, 2],
    };

    expect(
      getActiveQuestionIndices(questions, [
        selected(2),
        unanswered(),
        unanswered(),
      ]),
    ).toContain(1);
  });

  it("does not match free-form answers", () => {
    expect(
      getActiveQuestionIndices(conditionalQuestions(), [
        { selections: [{ wasCustom: true }] },
        unanswered(),
        unanswered(),
      ]),
    ).toEqual([0]);
  });

  it("supports nested conditions without activating descendants of hidden parents", () => {
    const questions = conditionalQuestions();
    questions[2]!.showWhen = {
      questionIndex: 2,
      selectedOptionIndices: [1],
    };

    expect(
      getActiveQuestionIndices(questions, [
        selected(1),
        selected(1),
        unanswered(),
      ]),
    ).toEqual([0, 1, 2]);
    expect(
      getActiveQuestionIndices(questions, [
        selected(2),
        selected(1),
        unanswered(),
      ]),
    ).toEqual([0]);
  });

  it("rejects forward and out-of-range references", () => {
    const forward = conditionalQuestions();
    forward[1]!.showWhen = {
      questionIndex: 2,
      selectedOptionIndices: [1],
    };
    expect(() => validateQuestionConditions(forward)).toThrow(
      "must reference an earlier question",
    );

    const invalidOption = conditionalQuestions();
    invalidOption[1]!.showWhen = {
      questionIndex: 1,
      selectedOptionIndices: [3],
    };
    expect(() => validateQuestionConditions(invalidOption)).toThrow(
      "has 2 options",
    );
  });
});
