import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ASK_USER_PARAMETER_DESCRIPTIONS } from "./prompt.ts";

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;
export const MAX_PREVIEW_LENGTH = 4_000;

export const QuestionTypeSchema = StringEnum(
  ["single", "multiple", "preview"] as const,
  {
    description: ASK_USER_PARAMETER_DESCRIPTIONS.questionType,
  },
);

const OptionFields = {
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
};

export const OptionSchema = Type.Object(OptionFields);

export const PreviewOptionSchema = Type.Object({
  ...OptionFields,
  preview: Type.String({
    minLength: 1,
    maxLength: MAX_PREVIEW_LENGTH,
    pattern: "\\S",
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionPreview,
  }),
});

export const ShowWhenSchema = Type.Object(
  {
    questionIndex: Type.Integer({
      minimum: 1,
      maximum: MAX_QUESTIONS,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.showWhenQuestionIndex,
    }),
    selectedOptionIndices: Type.Array(
      Type.Integer({ minimum: 1, maximum: MAX_OPTIONS }),
      {
        minItems: 1,
        maxItems: MAX_OPTIONS,
        uniqueItems: true,
        description:
          ASK_USER_PARAMETER_DESCRIPTIONS.showWhenSelectedOptionIndices,
      },
    ),
  },
  { description: ASK_USER_PARAMETER_DESCRIPTIONS.showWhen },
);

const QuestionFields = {
  label: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questionLabel,
    }),
  ),
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  showWhen: Type.Optional(ShowWhenSchema),
};

function questionSchema<TypeName extends "single" | "multiple">(
  type: TypeName,
  description: string,
) {
  return Type.Object({
    ...QuestionFields,
    type: StringEnum([type] as readonly [TypeName], {
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questionType,
    }),
    options: Type.Array(OptionSchema, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description,
    }),
  });
}

export const QuestionSchema = Type.Union([
  questionSchema("single", ASK_USER_PARAMETER_DESCRIPTIONS.options),
  questionSchema("multiple", ASK_USER_PARAMETER_DESCRIPTIONS.options),
  Type.Object({
    ...QuestionFields,
    type: StringEnum(["preview"] as const, {
      description: ASK_USER_PARAMETER_DESCRIPTIONS.questionType,
    }),
    options: Type.Array(PreviewOptionSchema, {
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.previewOptions,
    }),
  }),
]);

export const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: MIN_QUESTIONS,
    maxItems: MAX_QUESTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;
export type AskUserQuestionInput = Static<typeof QuestionSchema>;
export type AskUserQuestionType = AskUserQuestionInput["type"];

function defaultQuestionType(question: unknown): unknown {
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    return question;
  }

  const value = question as Record<string, unknown>;
  return value.type === undefined ? { ...value, type: "single" } : question;
}

/** Convert tool calls stored with older shapes to the current question schema. */
export function prepareAskUserArguments(args: unknown): AskUserInput {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args as AskUserInput;
  }

  const input = args as Record<string, unknown>;
  if (Array.isArray(input.questions)) {
    const existingQuestions = input.questions;
    const questions = existingQuestions.map(defaultQuestionType);
    const changed = questions.some(
      (question, index) => question !== existingQuestions[index],
    );
    return (changed ? { ...input, questions } : args) as AskUserInput;
  }

  if (typeof input.question !== "string" || !Array.isArray(input.options)) {
    return args as AskUserInput;
  }

  const { question, options, ...rest } = input;
  return {
    ...rest,
    questions: [{ question, type: "single", options }],
  } as AskUserInput;
}
