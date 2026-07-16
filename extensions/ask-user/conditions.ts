interface ConditionalQuestion {
  options: readonly unknown[];
  showWhen?: {
    questionIndex: number;
    selectedOptionIndices: readonly number[];
  };
}

interface ConditionalSelection {
  wasCustom: boolean;
  selectedIndex?: number;
}

interface ConditionalAnswer {
  selections: readonly ConditionalSelection[];
}

/** Validate cross-question references that JSON Schema cannot express. */
export function validateQuestionConditions(
  questions: readonly ConditionalQuestion[],
): void {
  for (let index = 0; index < questions.length; index++) {
    const condition = questions[index]!.showWhen;
    if (!condition) continue;

    const questionNumber = index + 1;
    if (
      !Number.isInteger(condition.questionIndex) ||
      condition.questionIndex < 1 ||
      condition.questionIndex >= questionNumber
    ) {
      throw new Error(
        `ask_user question ${questionNumber} showWhen.questionIndex must reference an earlier question (got ${condition.questionIndex}). Retry with a valid dependency.`,
      );
    }

    if (
      condition.selectedOptionIndices.length === 0 ||
      new Set(condition.selectedOptionIndices).size !==
        condition.selectedOptionIndices.length
    ) {
      throw new Error(
        `ask_user question ${questionNumber} showWhen.selectedOptionIndices must contain one or more unique option indices. Retry with a valid dependency.`,
      );
    }

    const sourceOptionCount =
      questions[condition.questionIndex - 1]!.options.length;
    const invalidOptionIndex = condition.selectedOptionIndices.find(
      (optionIndex) =>
        !Number.isInteger(optionIndex) ||
        optionIndex < 1 ||
        optionIndex > sourceOptionCount,
    );
    if (invalidOptionIndex !== undefined) {
      throw new Error(
        `ask_user question ${questionNumber} showWhen.selectedOptionIndices references option ${invalidOptionIndex}, but question ${condition.questionIndex} has ${sourceOptionCount} options. Retry with a valid dependency.`,
      );
    }
  }
}

/** Resolve visible questions in declaration order from the current answers. */
export function getActiveQuestionIndices(
  questions: readonly ConditionalQuestion[],
  answers: readonly ConditionalAnswer[],
): number[] {
  const active: number[] = [];
  const activeSet = new Set<number>();

  for (let index = 0; index < questions.length; index++) {
    const condition = questions[index]!.showWhen;
    if (!condition) {
      active.push(index);
      activeSet.add(index);
      continue;
    }

    const sourceIndex = condition.questionIndex - 1;
    if (!activeSet.has(sourceIndex)) continue;

    const selectedOptionIndices = new Set(
      answers[sourceIndex]?.selections.flatMap((selection) =>
        !selection.wasCustom && selection.selectedIndex !== undefined
          ? [selection.selectedIndex]
          : [],
      ) ?? [],
    );
    if (
      condition.selectedOptionIndices.some((optionIndex) =>
        selectedOptionIndices.has(optionIndex),
      )
    ) {
      active.push(index);
      activeSet.add(index);
    }
  }

  return active;
}
