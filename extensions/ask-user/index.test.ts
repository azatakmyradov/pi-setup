import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import askUser from "./index.ts";
import type { AskUserInput } from "./schema.ts";

interface TestToolResult {
  content: Array<{ type: string; text: string }>;
  details: unknown;
}

interface TestTheme {
  fg(color: string, text: string): string;
}

interface TestTool {
  execute(
    toolCallId: string,
    params: AskUserInput,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<TestToolResult>;
  renderResult(
    result: TestToolResult,
    options: unknown,
    theme: TestTheme,
    context: unknown,
  ): Component;
}

function registerTestTool(): TestTool {
  let tool: TestTool | undefined;
  const pi = {
    registerTool(definition: unknown) {
      tool = definition as TestTool;
    },
  } as unknown as ExtensionAPI;

  askUser(pi);
  if (!tool) throw new Error("ask_user was not registered");
  return tool;
}

function createTuiContext(
  inputs: readonly string[],
  inspect?: (component: Component) => void,
): unknown {
  const tui = { requestRender() {} };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  return {
    mode: "tui",
    ui: {
      custom: <Result>(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: Result) => void,
        ) => Component,
      ) =>
        new Promise<Result>((resolve) => {
          const component = factory(tui, theme, {}, resolve);
          inspect?.(component);
          for (const input of inputs) {
            component.handleInput?.(input);
            inspect?.(component);
          }
        }),
    },
  };
}

const batchedSingleParams: AskUserInput = {
  questions: [
    {
      label: "Scope",
      question: "Choose scope",
      type: "single",
      options: [{ label: "Focused" }, { label: "Broad" }],
    },
    {
      label: "Tests",
      question: "Choose test level",
      type: "single",
      options: [{ label: "Unit" }, { label: "Full" }],
    },
  ],
};

function multipleParams(optionCount = 2): AskUserInput {
  return {
    questions: [
      {
        label: "Targets",
        question: "Choose targets",
        type: "multiple",
        options: Array.from({ length: optionCount }, (_, index) => ({
          label: `Option ${index + 1}`,
        })),
      },
    ],
  };
}

async function execute(
  params: AskUserInput,
  inputs: readonly string[],
  inspect?: (component: Component) => void,
) {
  return registerTestTool().execute(
    "call",
    params,
    undefined,
    undefined,
    createTuiContext(inputs, inspect),
  );
}

function previewParams(): AskUserInput {
  return {
    questions: [
      {
        label: "Layout Style",
        question: "Choose a layout",
        type: "preview",
        options: [
          {
            label: "Sidebar Layout",
            description: "Navigation beside the content",
            preview: "  ┌────┬────────┐\n  │ Nav│ Content│\n  └────┴────────┘",
          },
          {
            label: "Top Navigation",
            preview:
              "  ┌─────────────┐\n  │ Navigation  │\n  ├─────────────┤\n  │ Content     │",
          },
        ],
      },
    ],
  };
}

describe("ask_user questionnaire", () => {
  it("retains single-choice select-and-advance behavior", async () => {
    const result = await execute(batchedSingleParams, [
      "\r", // Q1: Focused, advance to Q2
      "\x1b[D", // Return to Q1
      "\x1b[B", // Highlight Broad
      "\r", // Replace Q1 answer, advance to Q2
      "\r", // Q2: Unit, advance to Submit
      "\r", // Submit
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        {
          label: "Scope",
          type: "single",
          selections: [
            {
              answer: "Broad",
              selectedIndex: 2,
              wasCustom: false,
            },
          ],
        },
        {
          label: "Tests",
          type: "single",
          selections: [
            {
              answer: "Unit",
              selectedIndex: 1,
              wasCustom: false,
            },
          ],
        },
      ],
    });
    expect(result.content[0]?.text).toContain("User submitted these answers:");
  });

  it("toggles multiple options on and off", async () => {
    const result = await execute(multipleParams(), [
      " ", // Select option 1
      " ", // Deselect option 1
      "2", // Select option 2 directly
      "\r", // Confirm
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        {
          type: "multiple",
          selections: [
            {
              answer: "Option 2",
              selectedIndex: 2,
              wasCustom: false,
            },
          ],
        },
      ],
    });
  });

  it("allows every listed option to be selected", async () => {
    const result = await execute(multipleParams(5), [
      "1",
      "2",
      "3",
      "4",
      "5",
      "\r",
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        {
          selections: [
            { selectedIndex: 1 },
            { selectedIndex: 2 },
            { selectedIndex: 3 },
            { selectedIndex: 4 },
            { selectedIndex: 5 },
          ],
        },
      ],
    });
  });

  it("combines listed options with a custom response", async () => {
    const result = await execute(multipleParams(), [
      " ", // Select option 1
      "\x1b[B",
      "\x1b[B", // Highlight custom answer
      "\r", // Open editor
      ..."Custom target",
      "\r", // Save custom answer and submit
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        {
          selections: [
            {
              answer: "Option 1",
              selectedIndex: 1,
              wasCustom: false,
            },
            { answer: "Custom target", wasCustom: true },
          ],
        },
      ],
    });
    expect(result.content[0]?.text).toContain(
      "User wrote their own answer: Custom target",
    );
  });

  it("does not confirm a multi-select question with no selections", async () => {
    const result = await execute(multipleParams(), [
      "\r", // Must not submit
      " ", // Select option 1
      "\r", // Now submit
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [{ selections: [{ selectedIndex: 1 }] }],
    });
  });

  it("preserves and revises multi-select answers after changing tabs", async () => {
    const params: AskUserInput = {
      questions: [
        multipleParams().questions[0]!,
        batchedSingleParams.questions[1]!,
      ],
    };
    const result = await execute(params, [
      " ", // Q1: select option 1
      "\r", // Confirm Q1
      "\r", // Answer Q2 and advance to Submit
      "\x1b[D", // Q2
      "\x1b[D", // Q1
      "2", // Add option 2
      "1", // Remove option 1
      "\r", // Confirm revised Q1
      "\r", // Reconfirm Q2
      "\r", // Submit
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        { selections: [{ answer: "Option 2", selectedIndex: 2 }] },
        { selections: [{ answer: "Unit", selectedIndex: 1 }] },
      ],
    });
  });

  it("removes a custom multi-select answer without clearing listed options", async () => {
    const params: AskUserInput = {
      questions: [
        multipleParams().questions[0]!,
        batchedSingleParams.questions[1]!,
      ],
    };
    const result = await execute(params, [
      " ", // Q1: select option 1
      "\x1b[B",
      "\x1b[B",
      "\r",
      "Custom",
      "\r", // Save custom and advance
      "\r", // Answer Q2, go to Submit
      "\x1b[D",
      "\x1b[D", // Return to Q1; custom remains highlighted
      " ", // Remove custom
      "\x1b[A", // Move to option 2 so Enter confirms instead of editing custom
      "\r",
      "\r", // Reconfirm Q2
      "\r", // Submit
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        {
          selections: [
            {
              answer: "Option 1",
              selectedIndex: 1,
              wasCustom: false,
            },
          ],
        },
        { selections: [{ answer: "Unit", selectedIndex: 1 }] },
      ],
    });
  });

  it("renders multiple answers compactly in the transcript", () => {
    const tool = registerTestTool();
    const component = tool.renderResult(
      {
        content: [{ type: "text", text: "unused" }],
        details: {
          cancelled: false,
          questions: [
            {
              label: "Targets",
              question: "Choose targets",
              type: "multiple",
              options: ["Code", "Docs"],
              selections: [
                { answer: "Code", selectedIndex: 1, wasCustom: false },
                { answer: "Docs", selectedIndex: 2, wasCustom: false },
                { answer: "Keep compatibility", wasCustom: true },
              ],
            },
          ],
        },
      },
      {},
      { fg: (_color, text) => text },
      {},
    );

    expect(component.render(200).join("\n")).toContain(
      "✓ Targets [multiple]: 1. Code • 2. Docs • (wrote) Keep compatibility",
    );
  });

  it("updates preview content immediately as the highlight changes", async () => {
    const snapshots: string[] = [];
    await execute(previewParams(), ["\x1b[B", "\x1b"], (component) => {
      snapshots.push(component.render(70).join("\n"));
    });

    expect(snapshots[0]).toContain("│ Nav│ Content│");
    expect(snapshots.at(-1)).toContain("│ Navigation  │");
    expect(snapshots.at(-1)).not.toContain("│ Nav│ Content│");
  });

  it("renders responsive preview layouts without exceeding terminal width", async () => {
    let component: Component | undefined;
    await execute(previewParams(), ["\x1b"], (value) => {
      component ??= value;
    });

    const wide = component!.render(120);
    const narrow = component!.render(54);
    expect(
      wide.some(
        (line) =>
          line.includes("1. Sidebar Layout") && line.includes("Preview:"),
      ),
    ).toBe(true);
    expect(
      narrow.findIndex((line) => line.includes("1. Sidebar Layout")),
    ).toBeLessThan(narrow.findIndex((line) => line.includes("Preview:")));
    for (const width of [24, 54, 120]) {
      expect(
        component!.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
  });

  it("preserves ASCII whitespace and strips terminal control sequences", async () => {
    const params = previewParams();
    const first = params.questions[0]!.options[0]!;
    if (!("preview" in first)) throw new Error("Expected a preview option");
    first.preview = "\x1b[31m  +--+\x1b[0m\n  |  |\n\x1b]0;unsafe\x07  +--+";
    let rendered = "";
    await execute(params, ["\x1b"], (component) => {
      rendered = component.render(54).join("\n");
    });

    expect(rendered).toContain("   +--+");
    expect(rendered).toContain("   |  |");
    expect(rendered).not.toContain("[31m");
    expect(rendered).not.toContain("unsafe");
    expect(rendered).not.toContain("\x1b");
  });

  it("adds and edits supplemental notes without changing the selection", async () => {
    const result = await execute(previewParams(), [
      "N",
      ..."Prefer mobile",
      "\r",
      "N",
      ..." collapsible",
      "\r",
      "\x1b[B",
      "\r",
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        {
          type: "preview",
          notes: "Prefer mobile collapsible",
          selections: [
            {
              answer: "Top Navigation",
              selectedIndex: 2,
              wasCustom: false,
            },
          ],
        },
      ],
    });
    expect(result.content[0]?.text).toContain("Layout Style: Top Navigation");
    expect(result.content[0]?.text).toContain(
      "Notes: Prefer mobile collapsible",
    );
  });

  it("cancels note editing without replacing saved notes", async () => {
    const result = await execute(previewParams(), [
      "N",
      ..."Keep this",
      "\r",
      "N",
      ..." but not this",
      "\x1b",
      "\r",
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [{ notes: "Keep this", selections: [{ selectedIndex: 1 }] }],
    });
  });

  it("combines a custom preview answer with supplemental notes", async () => {
    const result = await execute(previewParams(), [
      "N",
      ..."Retain notes",
      "\r",
      "\x1b[B",
      "\x1b[B",
      "\r",
      ..."Hybrid layout",
      "\r",
    ]);

    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        {
          notes: "Retain notes",
          selections: [{ answer: "Hybrid layout", wasCustom: true }],
        },
      ],
    });
  });

  it("restores a preview question's confirmed selection and highlight", async () => {
    const params: AskUserInput = {
      questions: [
        previewParams().questions[0]!,
        batchedSingleParams.questions[1]!,
      ],
    };
    const snapshots: string[] = [];
    const result = await execute(
      params,
      ["2", "\r", "\x1b[D", "\r", "\r", "\r"],
      (component) => snapshots.push(component.render(70).join("\n")),
    );

    expect(
      snapshots.some((snapshot) => snapshot.includes("❯ 2. Top Navigation")),
    ).toBe(true);
    expect(result.details).toMatchObject({
      cancelled: false,
      questions: [
        { selections: [{ selectedIndex: 2 }] },
        { selections: [{ selectedIndex: 1 }] },
      ],
    });
  });

  it("shows a concise notes indicator unless transcript details are expanded", () => {
    const tool = registerTestTool();
    const result = {
      content: [{ type: "text", text: "unused" }],
      details: {
        cancelled: false,
        questions: [
          {
            label: "Layout Style",
            question: "Choose",
            type: "preview",
            options: ["Sidebar"],
            selections: [
              { answer: "Sidebar", selectedIndex: 1, wasCustom: false },
            ],
            notes: "Prefer a collapsible sidebar on mobile.",
          },
        ],
      },
    };

    expect(
      tool
        .renderResult(
          result,
          { expanded: false },
          { fg: (_color, text) => text },
          {},
        )
        .render(120)
        .join("\n"),
    ).toContain("notes added");
    expect(
      tool
        .renderResult(
          result,
          { expanded: true },
          { fg: (_color, text) => text },
          {},
        )
        .render(120)
        .join("\n"),
    ).toContain("Notes: Prefer a collapsible sidebar on mobile.");
  });

  it("discards partial selections and notes when dismissed", async () => {
    const params: AskUserInput = {
      questions: [
        previewParams().questions[0]!,
        batchedSingleParams.questions[1]!,
      ],
    };
    const result = await execute(params, [
      "N",
      ..."Discard me",
      "\r",
      "\r",
      "\x1b",
    ]);

    expect(result.details).toMatchObject({
      cancelled: true,
      questions: [
        { type: "preview", selections: [], notes: null },
        { type: "single", selections: [] },
      ],
    });
    expect(result.content[0]?.text).toContain(
      "Do not use any partial selections",
    );
  });

  it("discards partial multi-select selections when dismissed", async () => {
    const result = await execute(multipleParams(), [" ", "\x1b"]);

    expect(result.details).toMatchObject({
      cancelled: true,
      questions: [{ type: "multiple", selections: [] }],
    });
  });
});
