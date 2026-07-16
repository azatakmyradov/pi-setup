import type { AskUserQuestionType } from "./schema.ts";

/** Model-facing schema descriptions for ask_user questions and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  optionPreview:
    "Concise plain-text or ASCII preview for this option; whitespace and line structure are preserved",
  questionLabel:
    "Optional short tab label, such as 'Scope' or 'Priority'; defaults to Q1, Q2, and so on",
  question: "The question to ask the user",
  questionType:
    "Whether the user must select exactly one option ('single'), may select one or more options ('multiple'), or compares single-select visual text layouts ('preview')",
  showWhen:
    "Optional condition that shows this question only after a specific option is selected in one earlier question",
  showWhenQuestionIndex:
    "1-based index of the earlier question whose answer controls whether this question is shown",
  showWhenSelectedOptionIndices:
    "One or more 1-based listed-option indices; this question is shown when any of them is selected. Free-form answers never match.",
  questions: "Between 1 and 5 choice questions to ask together",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
  previewOptions:
    "Between 2 and 5 answer options, each with a non-empty concise plain-text preview. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Describes ask_user's batched questionnaire and dismissible free-form fallback. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one or more single-select, multi-select, or visual preview questions (up to 5, each with 2-5 options). Questions may be conditionally shown based on listed options selected in one earlier question. A free-form 'write my own answer' option is added to every question, and the user may dismiss the questionnaire without submitting answers.";

/** Adds ask_user's choice-question capability to the model's available-tools prompt. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask up to 5 single-select, multi-select, visual preview, or conditional questions, each with 2-5 options plus a free-form answer";

/** Guides the model on question types, batching, and conditional follow-ups. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user questions whose likely answers can be enumerated, use the ask_user tool instead of asking in plain text.",
  "Set ask_user question type to 'single' when its answers are mutually exclusive, and to 'multiple' when several answers may apply.",
  "Use ask_user question type 'preview' when users benefit from comparing visual structures such as page layouts, component arrangements, directory structures, data flows, terminal UI designs, or ASCII wireframes; every preview must be concise, readable plain text.",
  "Do not add an 'All of the above' ask_user option; use question type 'multiple' so the user can select every applicable option.",
  "Batch independent clarification questions into one ask_user call when that is more convenient for the user.",
  "When a dependent question's wording and options are known in advance, batch it with ask_user and use showWhen to reference one earlier question; the question is shown when any referenced listed option is selected, free-form answers never match, and question and option indices are 1-based.",
  "Ask a dependent follow-up in a later ask_user call when it depends on a free-form answer or its wording or options must be created from an earlier answer.",
];

export interface AskUserSelectionSummary {
  answer: string;
  wasCustom: boolean;
  selectedIndex?: number;
}

export interface AskUserAnswerSummary {
  label: string;
  question: string;
  type: AskUserQuestionType;
  selections: readonly AskUserSelectionSummary[];
  notes?: string | null;
}

/** Builds the behavioral tool-result message returned to the parent model. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "answered"; answers: readonly AskUserAnswerSummary[] },
): string {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the questions could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the questionnaire without submitting answers. Do not use any partial selections or assume answers; proceed accordingly or ask differently.";
    case "answered": {
      const heading =
        outcome.answers.length === 1
          ? "User submitted this answer:"
          : "User submitted these answers:";
      const lines = outcome.answers.flatMap((answer, index) => {
        if (answer.type === "preview") {
          const selection = answer.selections[0];
          return [
            `${answer.label}: ${selection?.answer ?? "Unanswered"}`,
            ...(answer.notes ? [`Notes: ${answer.notes}`] : []),
          ];
        }

        const responses = answer.selections.map((selection) =>
          selection.wasCustom
            ? `User wrote their own answer: ${selection.answer}`
            : `User selected option ${selection.selectedIndex}: ${selection.answer}`,
        );
        return [
          `${index + 1}. [${answer.label}] ${answer.question} (${answer.type === "multiple" ? "multiple selections allowed" : "single selection"})`,
          ...responses.map((response) => `   ${response}`),
        ];
      });
      return [heading, ...lines].join("\n");
    }
  }
}
