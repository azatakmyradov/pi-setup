import { describe, expect, it } from "vitest";
import {
  ASK_USER_PROMPT_GUIDELINES,
  buildAskUserResultMessage,
} from "./prompt.ts";

describe("buildAskUserResultMessage", () => {
  it("formats single and multi-select answers in question order", () => {
    expect(
      buildAskUserResultMessage({
        kind: "answered",
        answers: [
          {
            label: "Scope",
            question: "How broad should the change be?",
            type: "single",
            selections: [
              {
                answer: "Focused",
                wasCustom: false,
                selectedIndex: 1,
              },
            ],
          },
          {
            label: "Targets",
            question: "What should be updated?",
            type: "multiple",
            selections: [
              { answer: "Code", wasCustom: false, selectedIndex: 1 },
              { answer: "Docs", wasCustom: false, selectedIndex: 2 },
              {
                answer: "Keep the old API compatible",
                wasCustom: true,
              },
            ],
          },
        ],
      }),
    ).toBe(
      [
        "User submitted these answers:",
        "1. [Scope] How broad should the change be? (single selection)",
        "   User selected option 1: Focused",
        "2. [Targets] What should be updated? (multiple selections allowed)",
        "   User selected option 1: Code",
        "   User selected option 2: Docs",
        "   User wrote their own answer: Keep the old API compatible",
      ].join("\n"),
    );
  });

  it("uses a singular heading for one question answer", () => {
    expect(
      buildAskUserResultMessage({
        kind: "answered",
        answers: [
          {
            label: "Q1",
            question: "Continue?",
            type: "single",
            selections: [{ answer: "Yes", wasCustom: false, selectedIndex: 1 }],
          },
        ],
      }),
    ).toContain("User submitted this answer:");
  });

  it("reports preview selections concisely without returning their ASCII art", () => {
    expect(
      buildAskUserResultMessage({
        kind: "answered",
        answers: [
          {
            label: "Layout Style",
            question: "Choose a layout",
            type: "preview",
            selections: [
              {
                answer: "Sidebar Layout",
                wasCustom: false,
                selectedIndex: 1,
              },
            ],
            notes: "Prefer a collapsible sidebar on mobile.",
          },
        ],
      }),
    ).toBe(
      [
        "User submitted this answer:",
        "Layout Style: Sidebar Layout",
        "Notes: Prefer a collapsible sidebar on mobile.",
      ].join("\n"),
    );
  });

  it("makes dismissal semantics explicit", () => {
    const message = buildAskUserResultMessage({ kind: "dismissed" });
    expect(message).toContain("without submitting answers");
    expect(message).toContain("Do not use any partial selections");
  });
});

describe("ask_user model guidance", () => {
  it("explains question types, all-of-the-above, and dependent calls", () => {
    const guidance = ASK_USER_PROMPT_GUIDELINES.join("\n");
    expect(guidance).toContain("type to 'single'");
    expect(guidance).toContain("type 'multiple'");
    expect(guidance).toContain("All of the above");
    expect(guidance).toContain("type 'preview'");
    expect(guidance).toContain("ASCII wireframes");
    expect(guidance).toContain("concise, readable plain text");
    expect(guidance).toContain("showWhen");
    expect(guidance).toContain("one earlier question");
    expect(guidance).toContain("any referenced listed option");
    expect(guidance).toContain("free-form answers never match");
    expect(guidance).toContain("indices are 1-based");
    expect(guidance).toContain("later ask_user call");
    expect(guidance).toContain("free-form answer");
  });
});
