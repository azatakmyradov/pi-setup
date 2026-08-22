import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { z } from "zod";
import { ASK_USER_PARAMETER_DESCRIPTIONS } from "./prompt.ts";

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;
export const MAX_PREVIEW_LENGTH = 4_000;

export const QuestionTypeSchema = StringEnum(["single", "multiple", "preview"] as const, {
  description: ASK_USER_PARAMETER_DESCRIPTIONS.questionType,
});

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
    selectedOptionIndices: Type.Array(Type.Integer({ minimum: 1, maximum: MAX_OPTIONS }), {
      minItems: 1,
      maxItems: MAX_OPTIONS,
      uniqueItems: true,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.showWhenSelectedOptionIndices,
    }),
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
    type: StringEnum([type] as const, {
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

/**
 * A value carried by a tool call before pi validates it against
 * `AskUserParams`: plain JSON, plus `undefined` for fields the payload does not
 * carry at all.
 */
export type StoredValue = string | number | boolean | null | undefined | StoredValue[] | StoredCall;

/** The fields of a stored tool call, its questions, options, or answers. */
export interface StoredCall {
  readonly [field: string]: StoredValue;
}

const plainObject = z.looseObject({});

/**
 * Narrows a stored value to an object without copying it, so the migration
 * below can hand back the caller's own objects when nothing has to change.
 */
export const storedCallSchema = z.custom<StoredCall>(
  (value) => plainObject.safeParse(value).success,
);

/** Narrows a stored field to text; every string-typed field goes through this. */
export const storedTextSchema = z.string();

/** Questions stored before an explicit question type existed are single-select. */
function defaultQuestionType(question: StoredValue): StoredValue {
  const fields = storedCallSchema.safeParse(question);
  if (!fields.success) return question;
  return fields.data.type === undefined ? { ...fields.data, type: "single" } : question;
}

/**
 * Convert tool calls stored with older shapes to the current question schema.
 * The caller's own objects are returned whenever nothing needs converting, and
 * pi validates the migrated call against `AskUserParams` afterwards.
 */
export function prepareAskUserArguments(args: StoredCall): StoredCall {
  const storedQuestions = args.questions;
  if (Array.isArray(storedQuestions)) {
    const questions = storedQuestions.map(defaultQuestionType);
    const changed = questions.some((question, index) => question !== storedQuestions[index]);
    return changed ? { ...args, questions } : args;
  }

  const legacyQuestion = storedTextSchema.safeParse(args.question);
  const legacyOptions = args.options;
  if (!legacyQuestion.success || !Array.isArray(legacyOptions)) {
    return args;
  }

  const { question: _question, options: _options, ...rest } = args;
  return {
    ...rest,
    questions: [{ question: legacyQuestion.data, type: "single", options: legacyOptions }],
  };
}
