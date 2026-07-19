/**
 * ask_user - Lets the model ask one or more choice questions.
 *
 * - 1 to 5 questions, each with 2 to 5 model-provided options
 * - Explicit single-select, multi-select, or visual-preview behavior per question
 * - Preview questions support optional supplemental notes
 * - An always-present "Write my own answer" option for every question
 * - Questions may be hidden until listed options in an earlier question are selected
 * - Multiple questions use tabs and a final review/submit screen
 * - Esc in an editor returns to the options; Esc elsewhere dismisses the batch
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { dividerLine, glyphs, selectListTheme, separators } from "../shared/ui-kit.ts";
import {
  getActiveQuestionIndices,
  validateQuestionConditions,
} from "./conditions.ts";
import {
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
  type AskUserAnswerSummary,
} from "./prompt.ts";
import {
  AskUserParams,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  MIN_QUESTIONS,
  prepareAskUserArguments,
  type AskUserInput,
  type AskUserQuestionInput,
  type AskUserQuestionType,
} from "./schema.ts";

export type { AskUserInput } from "./schema.ts";

interface NormalizedQuestion {
  label: string;
  question: string;
  type: AskUserQuestionType;
  options: AskUserQuestionInput["options"];
  showWhen?: AskUserQuestionInput["showWhen"];
}

interface AnswerSelection {
  answer: string;
  selectedIndex?: number;
  wasCustom: boolean;
}

interface QuestionAnswer {
  type: AskUserQuestionType;
  selections: AnswerSelection[];
  notes: string | null;
}

interface AskUserQuestionDetails {
  label: string;
  question: string;
  type: AskUserQuestionType;
  options: string[];
  selections: AnswerSelection[];
  active: boolean;
  notes?: string | null;
}

interface AskUserDetails {
  questions: AskUserQuestionDetails[];
  cancelled: boolean;
}

interface LegacyBatchedQuestionDetails {
  label: string;
  answer: string | null;
  wasCustom: boolean;
  selectedIndex?: number;
}

interface LegacyAskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
}

type QuestionnaireResult = { answers: QuestionAnswer[] } | null;

interface DisplayOption {
  label: string;
  description?: string;
  preview?: string;
  isOther?: boolean;
}

type EditorMode = "custom-answer" | "notes" | null;

interface RenderQuestion {
  label: string;
  question: string;
  type: AskUserQuestionType;
  options: string[];
}

const WIDE_PREVIEW_MIN_WIDTH = 88;

/** Remove control sequences while retaining the whitespace that shapes ASCII art. */
export function sanitizePreview(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);

    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index++;
        }
      } else if (
        next === 0x5d ||
        next === 0x50 ||
        next === 0x5e ||
        next === 0x5f
      ) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index++;
            break;
          }
          index++;
        }
      } else {
        index++;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current < 0x20 || current > 0x2f) break;
          index++;
        }
      }
      continue;
    }

    if (code === 0x9b) {
      while (++index < value.length) {
        const current = value.charCodeAt(index);
        if (current >= 0x40 && current <= 0x7e) break;
      }
      continue;
    }

    if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
      while (++index < value.length) {
        const current = value.charCodeAt(index);
        if (current === 0x07 || current === 0x9c) break;
      }
      continue;
    }

    if (code === 0x09) {
      const lineStart = result.lastIndexOf("\n") + 1;
      const column = visibleWidth(result.slice(lineStart));
      result += " ".repeat(4 - (column % 4));
      continue;
    }
    if (code === 0x0d) {
      if (value.charCodeAt(index + 1) !== 0x0a) result += "\n";
      continue;
    }
    if (
      code === 0x0a ||
      (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
    ) {
      result += value[index];
    }
  }

  return result;
}

function normalizeQuestions(
  questions: AskUserInput["questions"],
): NormalizedQuestion[] {
  return questions.map((question, index) => ({
    label: question.label?.trim() || `Q${index + 1}`,
    question: question.question,
    type: question.type,
    options: question.options.map((option) => ({
      ...option,
      ...(question.type === "preview"
        ? {
            preview: sanitizePreview("preview" in option ? option.preview : ""),
          }
        : {}),
    })),
    ...(question.showWhen ? { showWhen: question.showWhen } : {}),
  }));
}

function getRenderQuestions(args: unknown): RenderQuestion[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];

  const input = args as Record<string, unknown>;
  const candidates = Array.isArray(input.questions)
    ? input.questions
    : typeof input.question === "string" && Array.isArray(input.options)
      ? [{ question: input.question, options: input.options }]
      : [];

  return candidates.flatMap((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return [];
    }

    const question = candidate as Record<string, unknown>;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const label = (option as Record<string, unknown>).label;
          return typeof label === "string" ? [label] : [];
        })
      : [];

    return [
      {
        label:
          typeof question.label === "string" && question.label.trim()
            ? question.label.trim()
            : `Q${index + 1}`,
        question:
          typeof question.question === "string" ? question.question : "",
        type:
          question.type === "multiple" || question.type === "preview"
            ? question.type
            : "single",
        options,
      },
    ];
  });
}

function isAskUserDetails(value: unknown): value is AskUserDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  return (
    Array.isArray(details.questions) && typeof details.cancelled === "boolean"
  );
}

function isLegacyAskUserDetails(value: unknown): value is LegacyAskUserDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  return (
    typeof details.question === "string" &&
    Array.isArray(details.options) &&
    (typeof details.answer === "string" || details.answer === null) &&
    typeof details.cancelled === "boolean"
  );
}

function cloneAnswers(answers: readonly QuestionAnswer[]): QuestionAnswer[] {
  return answers.map((answer) => ({
    type: answer.type,
    selections: answer.selections.map((selection) => ({ ...selection })),
    notes: answer.notes,
  }));
}

function orderedSelections(
  selections: readonly AnswerSelection[],
): AnswerSelection[] {
  return [...selections].sort((left, right) => {
    if (left.wasCustom) return right.wasCustom ? 0 : 1;
    if (right.wasCustom) return -1;
    return (left.selectedIndex ?? 0) - (right.selectedIndex ?? 0);
  });
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,
    prepareArguments: prepareAskUserArguments,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params.questions);

      const reply = (
        text: string,
        answers: readonly QuestionAnswer[] | undefined = undefined,
        cancelled = true,
      ) => {
        const resolvedAnswers =
          answers ??
          questions.map((question) => ({
            type: question.type,
            selections: [],
            notes: null,
          }));
        const activeQuestionIndices = new Set(
          getActiveQuestionIndices(questions, resolvedAnswers),
        );

        return {
          content: [{ type: "text" as const, text }],
          details: {
            questions: questions.map((question, index) => ({
              label: question.label,
              question: question.question,
              type: question.type,
              options: question.options.map((option) => option.label),
              selections:
                answers?.[index]?.selections.map((selection) => ({
                  ...selection,
                })) ?? [],
              active: activeQuestionIndices.has(index),
              ...(question.type === "preview"
                ? { notes: answers?.[index]?.notes ?? null }
                : {}),
            })),
            cancelled,
          } satisfies AskUserDetails,
        };
      };

      if (
        questions.length < MIN_QUESTIONS ||
        questions.length > MAX_QUESTIONS
      ) {
        throw new Error(
          `ask_user requires between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions (got ${questions.length}). Retry with a valid number of questions.`,
        );
      }

      for (let index = 0; index < questions.length; index++) {
        const optionCount = questions[index]!.options.length;
        if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) {
          throw new Error(
            `ask_user question ${index + 1} requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${optionCount}). Retry with a valid number of options.`,
          );
        }
      }
      validateQuestionConditions(questions);

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const showQuestionnaire = (uiSignal: AbortSignal) =>
        ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
          const hasTabs = questions.length > 1;
          const answers: QuestionAnswer[] = questions.map((question) => ({
            type: question.type,
            selections: [],
            notes: null,
          }));
          const optionIndices = questions.map(() => 0);

          let currentTab = 0;
          let editorMode: EditorMode = null;
          let editQuestionIndex: number | undefined;
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;
          let settled = false;

          function finish(result: QuestionnaireResult) {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", cancel);
            done(result);
          }

          function cancel() {
            finish(null);
          }

          uiSignal.addEventListener("abort", cancel, { once: true });
          if (uiSignal.aborted) queueMicrotask(cancel);

          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: selectListTheme(theme),
          };
          const editor = new Editor(tui, editorTheme);

          function refresh() {
            cachedWidth = undefined;
            cachedLines = undefined;
            tui.requestRender();
          }

          function activeQuestionIndices() {
            return getActiveQuestionIndices(questions, answers);
          }

          function reconcileInactiveAnswers() {
            const active = new Set(activeQuestionIndices());
            for (let index = 0; index < answers.length; index++) {
              if (active.has(index)) continue;
              answers[index]!.selections = [];
              answers[index]!.notes = null;
              optionIndices[index] = 0;
            }
          }

          function isAnswered(questionIndex: number) {
            return answers[questionIndex]!.selections.length > 0;
          }

          function allAnswered() {
            return activeQuestionIndices().every(isAnswered);
          }

          function submit() {
            if (!allAnswered()) return;
            finish({ answers: cloneAnswers(answers) });
          }

          function advanceAfterAnswer() {
            reconcileInactiveAnswers();
            if (!hasTabs) {
              submit();
              return;
            }

            const active = activeQuestionIndices();
            const position = active.indexOf(currentTab);
            currentTab =
              position >= 0 && position < active.length - 1
                ? active[position + 1]!
                : questions.length;
            refresh();
          }

          function saveCustomAnswer(questionIndex: number, answer: string) {
            const questionAnswer = answers[questionIndex]!;
            const custom: AnswerSelection = {
              answer,
              wasCustom: true,
            };
            questionAnswer.selections =
              questionAnswer.type === "single"
                ? [custom]
                : orderedSelections([
                    ...questionAnswer.selections.filter(
                      (selection) => !selection.wasCustom,
                    ),
                    custom,
                  ]);
            optionIndices[questionIndex] =
              questions[questionIndex]!.options.length;
          }

          editor.onSubmit = (value) => {
            if (editQuestionIndex === undefined || editorMode === null) return;

            const questionIndex = editQuestionIndex;
            const trimmed = value.trim();
            const submittedMode = editorMode;
            editorMode = null;
            editQuestionIndex = undefined;
            editor.setText("");

            if (submittedMode === "notes") {
              answers[questionIndex]!.notes = trimmed || null;
              refresh();
              return;
            }

            if (!trimmed) {
              refresh();
              return;
            }

            saveCustomAnswer(questionIndex, trimmed);
            advanceAfterAnswer();
          };

          function currentOptions(): DisplayOption[] {
            const question = questions[currentTab];
            if (!question) return [];
            return [
              ...question.options,
              { label: "Write my own answer…", isOther: true },
            ];
          }

          function openCustomEditor(questionIndex: number) {
            const existing = answers[questionIndex]!.selections.find(
              (selection) => selection.wasCustom,
            );
            optionIndices[questionIndex] =
              questions[questionIndex]!.options.length;
            editorMode = "custom-answer";
            editQuestionIndex = questionIndex;
            editor.setText(existing?.answer ?? "");
            refresh();
          }

          function openNotesEditor(questionIndex: number) {
            if (questions[questionIndex]?.type !== "preview") return;
            editorMode = "notes";
            editQuestionIndex = questionIndex;
            editor.setText(answers[questionIndex]!.notes ?? "");
            refresh();
          }

          function selectSingleOption(index: number) {
            const question = questions[currentTab];
            const selected = currentOptions()[index];
            if (!question || !selected) return;

            optionIndices[currentTab] = index;
            if (selected.isOther) {
              openCustomEditor(currentTab);
              return;
            }

            answers[currentTab]!.selections = [
              {
                answer: selected.label,
                wasCustom: false,
                selectedIndex: index + 1,
              },
            ];
            advanceAfterAnswer();
          }

          function toggleMultipleOption(index: number) {
            const question = questions[currentTab];
            if (!question || index < 0 || index >= question.options.length) {
              return;
            }

            optionIndices[currentTab] = index;
            const questionAnswer = answers[currentTab]!;
            const selectedIndex = index + 1;
            const existing = questionAnswer.selections.findIndex(
              (selection) =>
                !selection.wasCustom &&
                selection.selectedIndex === selectedIndex,
            );
            if (existing >= 0) {
              questionAnswer.selections.splice(existing, 1);
            } else {
              questionAnswer.selections = orderedSelections([
                ...questionAnswer.selections,
                {
                  answer: question.options[index]!.label,
                  wasCustom: false,
                  selectedIndex,
                },
              ]);
            }
            reconcileInactiveAnswers();
            refresh();
          }

          function toggleCustomAnswer() {
            const questionAnswer = answers[currentTab]!;
            const existing = questionAnswer.selections.findIndex(
              (selection) => selection.wasCustom,
            );
            if (existing >= 0) {
              questionAnswer.selections.splice(existing, 1);
              reconcileInactiveAnswers();
              refresh();
              return;
            }
            openCustomEditor(currentTab);
          }

          function confirmMultipleQuestion() {
            const question = questions[currentTab];
            if (!question) return;
            const highlighted = optionIndices[currentTab]!;
            if (highlighted === question.options.length) {
              openCustomEditor(currentTab);
            } else if (isAnswered(currentTab)) {
              advanceAfterAnswer();
            }
          }

          function navigate(direction: 1 | -1) {
            const tabs = [...activeQuestionIndices(), questions.length];
            const currentPosition = tabs.indexOf(currentTab);
            const nextPosition =
              (Math.max(0, currentPosition) + direction + tabs.length) %
              tabs.length;
            currentTab = tabs[nextPosition]!;
            refresh();
          }

          function handleInput(data: string) {
            if (settled) return;

            if (editorMode !== null) {
              if (matchesKey(data, Key.escape)) {
                editorMode = null;
                editQuestionIndex = undefined;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (hasTabs) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                navigate(1);
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) ||
                matchesKey(data, Key.left)
              ) {
                navigate(-1);
                return;
              }
            }

            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter)) submit();
              else if (matchesKey(data, Key.escape)) cancel();
              return;
            }

            const question = questions[currentTab]!;
            const allOptions = currentOptions();
            if (question.type === "preview" && data === "N") {
              openNotesEditor(currentTab);
              return;
            }
            if (matchesKey(data, Key.up)) {
              optionIndices[currentTab] =
                (optionIndices[currentTab]! - 1 + allOptions.length) %
                allOptions.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndices[currentTab] =
                (optionIndices[currentTab]! + 1) % allOptions.length;
              refresh();
              return;
            }

            if (question.type === "multiple") {
              if (
                data.length === 1 &&
                data >= "1" &&
                data <= String(question.options.length)
              ) {
                toggleMultipleOption(Number(data) - 1);
                return;
              }

              if (matchesKey(data, Key.space)) {
                const highlighted = optionIndices[currentTab]!;
                if (highlighted === question.options.length) {
                  toggleCustomAnswer();
                } else {
                  toggleMultipleOption(highlighted);
                }
                return;
              }

              if (matchesKey(data, Key.enter)) {
                confirmMultipleQuestion();
                return;
              }
            } else {
              if (
                data.length === 1 &&
                data >= "1" &&
                data <= String(allOptions.length)
              ) {
                const selectedIndex = Number(data) - 1;
                if (question.type === "preview") {
                  optionIndices[currentTab] = selectedIndex;
                  refresh();
                } else {
                  selectSingleOption(selectedIndex);
                }
                return;
              }

              if (matchesKey(data, Key.enter)) {
                selectSingleOption(optionIndices[currentTab]!);
                return;
              }
            }

            if (matchesKey(data, Key.escape)) cancel();
          }

          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;

            const lines: string[] = [];
            const renderWidth = Math.max(1, width);

            function addWrapped(text: string) {
              lines.push(...wrapTextWithAnsi(text, renderWidth));
            }

            function addWrappedWithPrefix(prefix: string, text: string) {
              const prefixWidth = visibleWidth(prefix);
              if (prefixWidth >= renderWidth) {
                addWrapped(prefix + text);
                return;
              }

              const wrapped = wrapTextWithAnsi(
                text,
                Math.max(1, renderWidth - prefixWidth),
              );
              const continuationPrefix = " ".repeat(prefixWidth);
              for (let index = 0; index < wrapped.length; index++) {
                lines.push(
                  `${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`,
                );
              }
            }

            lines.push(dividerLine(theme, renderWidth));

            if (hasTabs) {
              const tabs = activeQuestionIndices().map((questionIndex) => {
                const question = questions[questionIndex]!;
                const indicator = isAnswered(questionIndex) ? glyphs.success : glyphs.pending;
                const text = ` ${indicator} ${question.label} `;
                if (questionIndex === currentTab) {
                  return theme.bg("selectedBg", theme.fg("text", text));
                }
                return theme.fg(
                  isAnswered(questionIndex) ? "success" : "muted",
                  text,
                );
              });
              const submitText = ` ${glyphs.success} Submit `;
              tabs.push(
                currentTab === questions.length
                  ? theme.bg("selectedBg", theme.fg("text", submitText))
                  : theme.fg(allAnswered() ? "success" : "dim", submitText),
              );
              addWrappedWithPrefix(" ", `← ${tabs.join(" ")} →`);
              lines.push("");
            }

            if (currentTab === questions.length) {
              addWrappedWithPrefix(
                " ",
                theme.fg("accent", theme.bold("Review answers")),
              );
              lines.push("");

              for (const index of activeQuestionIndices()) {
                const question = questions[index]!;
                const selections = answers[index]!.selections;
                const value = selections.length
                  ? selections
                      .map(
                        (selection) =>
                          `${selection.wasCustom ? "(wrote) " : ""}${selection.answer}`,
                      )
                      .join(", ")
                  : "Unanswered";
                addWrappedWithPrefix(
                  ` ${theme.fg("muted", `${question.label}: `)}`,
                  theme.fg(selections.length ? "text" : "warning", value),
                );
                if (question.type === "preview" && answers[index]!.notes) {
                  addWrappedWithPrefix("   ", theme.fg("muted", "Notes added"));
                }
              }

              lines.push("");
              addWrappedWithPrefix(
                " ",
                allAnswered()
                  ? theme.fg("success", "Press Enter to submit all answers")
                  : theme.fg(
                      "warning",
                      "Answer every question before submitting",
                    ),
              );
            } else {
              const question = questions[currentTab]!;
              const allOptions = currentOptions();
              const selections = answers[currentTab]!.selections;
              addWrappedWithPrefix(
                " ",
                theme.fg("text", theme.bold(question.question)),
              );
              addWrappedWithPrefix(
                " ",
                theme.fg(
                  "muted",
                  question.type === "multiple"
                    ? "Select one or more"
                    : question.type === "preview"
                      ? "Select one • N add or edit notes"
                      : "Select one",
                ),
              );
              lines.push("");

              function optionRows(rowWidth: number): string[] {
                const rows: string[] = [];
                const safeWidth = Math.max(1, rowWidth);
                const pushWrapped = (prefix: string, text: string) => {
                  const prefixWidth = visibleWidth(prefix);
                  const contentWidth = Math.max(1, safeWidth - prefixWidth);
                  const wrapped = wrapTextWithAnsi(text, contentWidth);
                  for (let index = 0; index < wrapped.length; index++) {
                    rows.push(
                      `${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`,
                    );
                  }
                };

                for (let index = 0; index < allOptions.length; index++) {
                  const option = allOptions[index]!;
                  const highlighted = index === optionIndices[currentTab];
                  const prefix = highlighted ? theme.fg("accent", `${glyphs.selectPrefix} `) : "  ";
                  const checked = option.isOther
                    ? selections.some((selection) => selection.wasCustom)
                    : selections.some(
                        (selection) =>
                          !selection.wasCustom &&
                          selection.selectedIndex === index + 1,
                      );
                  const marker =
                    question.type === "multiple"
                      ? `${checked ? "☑" : "☐"} ${option.isOther ? "✎" : `${index + 1}.`}`
                      : option.isOther
                        ? "✎"
                        : `${index + 1}.`;
                  const custom = option.isOther
                    ? selections.find((selection) => selection.wasCustom)
                    : undefined;
                  const label = `${marker} ${custom ? custom.answer : option.label}`;
                  pushWrapped(
                    prefix,
                    theme.fg(
                      highlighted
                        ? "accent"
                        : checked
                          ? "success"
                          : option.isOther
                            ? "muted"
                            : "text",
                      label,
                    ),
                  );

                  if (option.description) {
                    pushWrapped("    ", theme.fg("muted", option.description));
                  }
                }
                return rows;
              }

              if (question.type === "preview") {
                const highlighted = allOptions[optionIndices[currentTab]!]!;
                const preview = highlighted.preview;
                const previewRows = [
                  theme.fg(
                    "accent",
                    theme.bold(`Preview: ${highlighted.label}`),
                  ),
                  "",
                  ...(preview
                    ? preview.split("\n")
                    : [theme.fg("dim", "No preview for a custom answer.")]),
                ];

                if (renderWidth >= WIDE_PREVIEW_MIN_WIDTH) {
                  const contentWidth = Math.max(1, renderWidth - 2);
                  const separator = theme.fg("dim", " │ ");
                  const separatorWidth = 3;
                  const leftWidth = Math.max(
                    28,
                    Math.floor((contentWidth - separatorWidth) * 0.4),
                  );
                  const rightWidth = Math.max(
                    1,
                    contentWidth - leftWidth - separatorWidth,
                  );
                  const leftRows = optionRows(leftWidth);
                  const rowCount = Math.max(
                    leftRows.length,
                    previewRows.length,
                  );
                  for (let index = 0; index < rowCount; index++) {
                    const left = truncateToWidth(
                      leftRows[index] ?? "",
                      leftWidth,
                      "",
                    );
                    const paddedLeft =
                      left +
                      " ".repeat(Math.max(0, leftWidth - visibleWidth(left)));
                    const right = truncateToWidth(
                      previewRows[index] ?? "",
                      rightWidth,
                      "",
                    );
                    lines.push(` ${paddedLeft}${separator}${right}`);
                  }
                } else {
                  lines.push(
                    ...optionRows(Math.max(1, renderWidth - 1)).map(
                      (line) => ` ${line}`,
                    ),
                  );
                  lines.push("");
                  for (const line of previewRows) {
                    lines.push(
                      ` ${truncateToWidth(line, Math.max(1, renderWidth - 1), "")}`,
                    );
                  }
                }
              } else {
                lines.push(
                  ...optionRows(Math.max(1, renderWidth - 1)).map(
                    (line) => ` ${line}`,
                  ),
                );
              }

              if (editorMode !== null) {
                lines.push("");
                addWrappedWithPrefix(
                  " ",
                  theme.fg(
                    "muted",
                    editorMode === "notes" ? "Notes:" : "Your answer:",
                  ),
                );
                for (const line of editor.render(
                  Math.max(1, renderWidth - 2),
                )) {
                  lines.push(` ${line}`);
                }
              }
            }

            lines.push("");
            const sep = ` ${separators.dot} `;
            let help: string;
            if (editorMode !== null) {
              help =
                editorMode === "notes"
                  ? `Enter save notes${sep}Esc keep previous notes`
                  : `Enter save answer${sep}Esc preserve previous answer`;
            } else if (currentTab === questions.length) {
              help = `Tab/←→ questions${sep}Enter submit${sep}Esc dismiss`;
            } else {
              const question = questions[currentTab]!;
              const navigation = hasTabs ? `Tab/←→ questions${sep}` : "";
              help =
                question.type === "multiple"
                  ? `${navigation}↑↓ highlight${sep}Space/1-${question.options.length} toggle${sep}Enter confirm${sep}Esc dismiss`
                  : question.type === "preview"
                    ? `${navigation}↑↓/1-${currentOptions().length} highlight${sep}N notes${sep}Enter confirm${sep}Esc dismiss`
                    : `${navigation}↑↓ or 1-${currentOptions().length} select${sep}Enter confirm${sep}Esc dismiss`;
              if (question.type === "preview") {
                help += answers[currentTab]!.notes
                  ? `${sep}Notes added`
                  : `${sep}No notes`;
              }
            }
            addWrappedWithPrefix(" ", theme.fg("dim", help));
            lines.push(dividerLine(theme, renderWidth));

            const fittedLines = lines.map((line) =>
              truncateToWidth(line, renderWidth, ""),
            );
            cachedWidth = width;
            cachedLines = fittedLines;
            return fittedLines;
          }

          let focused = false;
          const component: Component & Focusable & { dispose(): void } = {
            get focused() {
              return focused;
            },
            set focused(value: boolean) {
              focused = value;
              editor.focused = value;
            },
            render,
            invalidate: () => {
              cachedWidth = undefined;
              cachedLines = undefined;
              editor.invalidate();
            },
            handleInput,
            dispose: () => {
              uiSignal.removeEventListener("abort", cancel);
            },
          };
          return component;
        });

      const uiExit = await Effect.runPromiseExit(
        Effect.tryPromise(showQuestionnaire),
        signal ? { signal } : undefined,
      );

      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }));
        }
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const result = uiExit.value;
      if (!result) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }

      const activeQuestionIndices = getActiveQuestionIndices(
        questions,
        result.answers,
      );
      const summaries: AskUserAnswerSummary[] = activeQuestionIndices.map(
        (index) => {
          const answer = result.answers[index]!;
          return {
            label: questions[index]!.label,
            question: questions[index]!.question,
            type: answer.type,
            selections: answer.selections,
            ...(answer.type === "preview" ? { notes: answer.notes } : {}),
          };
        },
      );

      return reply(
        buildAskUserResultMessage({ kind: "answered", answers: summaries }),
        result.answers,
        false,
      );
    },

    renderCall(args, theme, _context) {
      const questions = getRenderQuestions(args);
      let text = theme.fg("toolTitle", theme.bold("ask_user "));

      if (questions.length === 1) {
        const question = questions[0]!;
        const type =
          question.type === "multiple"
            ? "multi-select"
            : question.type === "preview"
              ? "preview"
              : "single";
        text += theme.fg("muted", `[${type}] ${question.question}`);
        if (question.options.length > 0) {
          const numbered = question.options.map(
            (option, index) => `${index + 1}. ${option}`,
          );
          text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
        }
      } else {
        const singleCount = questions.filter(
          (question) => question.type === "single",
        ).length;
        const multipleCount = questions.filter(
          (question) => question.type === "multiple",
        ).length;
        const previewCount = questions.filter(
          (question) => question.type === "preview",
        ).length;
        const typeSummary = [
          singleCount ? `${singleCount} single` : "",
          multipleCount ? `${multipleCount} multi-select` : "",
          previewCount ? `${previewCount} preview` : "",
        ]
          .filter(Boolean)
          .join(", ");
        text += theme.fg(
          "muted",
          `${questions.length} questions${typeSummary ? ` (${typeSummary})` : ""}${questions.length ? `: ${questions.map((question) => question.label).join(", ")}` : ""}`,
        );
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details: unknown = result.details;
      if (isAskUserDetails(details)) {
        if (details.cancelled) {
          return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
        }

        const activeQuestions = details.questions.filter(
          (question) => question.active !== false,
        );
        const lines = activeQuestions.map((questionValue) => {
          const question = questionValue as unknown as Record<string, unknown>;
          const label =
            typeof question.label === "string" ? question.label : "Question";
          const type =
            question.type === "multiple"
              ? "multiple"
              : question.type === "preview"
                ? "preview"
                : "single";
          const notes =
            question.type === "preview" && typeof question.notes === "string"
              ? question.notes
              : null;
          const rawSelections = Array.isArray(question.selections)
            ? question.selections
            : undefined;

          let selections: AnswerSelection[] = [];
          if (rawSelections) {
            selections = rawSelections.flatMap((selection) => {
              if (
                !selection ||
                typeof selection !== "object" ||
                Array.isArray(selection)
              ) {
                return [];
              }
              const value = selection as Record<string, unknown>;
              if (
                typeof value.answer !== "string" ||
                typeof value.wasCustom !== "boolean"
              ) {
                return [];
              }
              return [
                {
                  answer: value.answer,
                  wasCustom: value.wasCustom,
                  ...(typeof value.selectedIndex === "number"
                    ? { selectedIndex: value.selectedIndex }
                    : {}),
                },
              ];
            });
          } else {
            const legacy =
              questionValue as unknown as LegacyBatchedQuestionDetails;
            if (typeof legacy.answer === "string") {
              selections = [
                {
                  answer: legacy.answer,
                  wasCustom: legacy.wasCustom,
                  ...(legacy.selectedIndex === undefined
                    ? {}
                    : { selectedIndex: legacy.selectedIndex }),
                },
              ];
            }
          }

          if (selections.length === 0) {
            return `${theme.fg("warning", "○ ")}${theme.fg("accent", label)}: unanswered`;
          }

          const rendered = selections
            .map((selection) =>
              selection.wasCustom
                ? `${theme.fg("muted", "(wrote) ")}${theme.fg("accent", selection.answer)}`
                : theme.fg(
                    "accent",
                    selection.selectedIndex
                      ? `${selection.selectedIndex}. ${selection.answer}`
                      : selection.answer,
                  ),
            )
            .join(theme.fg("dim", ` ${separators.dot} `));
          const typeLabel = theme.fg("muted", ` [${type}]`);
          const summary = `${theme.fg("success", `${glyphs.success} `)}${theme.fg("accent", label)}${typeLabel}: ${rendered}`;
          if (!notes) return summary;
          return expanded
            ? `${summary}\n  ${theme.fg("muted", "Notes: ")}${notes}`
            : `${summary}${theme.fg("muted", " • notes added")}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      }

      if (isLegacyAskUserDetails(details)) {
        if (details.cancelled || details.answer === null) {
          return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
        }
        const index = details.options.indexOf(details.answer) + 1;
        const answer = details.wasCustom
          ? `${theme.fg("muted", "(wrote) ")}${theme.fg("accent", details.answer)}`
          : theme.fg(
              "accent",
              index > 0 ? `${index}. ${details.answer}` : details.answer,
            );
        return new Text(theme.fg("success", "✓ ") + answer, 0, 0);
      }

      const first = result.content[0];
      return new Text(first?.type === "text" ? first.text : "", 0, 0);
    },
  });
}
