import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  addUserMessageBorder,
  alignColumns,
  createScannerFrames,
  InterruptConfirmation,
  findClipboardImagePaths,
  findImagePathReferences,
  formatClipboardAttachmentPrompt,
  formatDuration,
  formatTokens,
  interruptPrompt,
  layoutEditorPanel,
  OpenCodeEditor,
  promptWidth,
  renderAttachmentFiles,
} from "./index.ts";

test("uses the full terminal width for the prompt", () => {
  assert.equal(promptWidth(120), 120);
  assert.equal(promptWidth(60), 60);
  assert.equal(promptWidth(0), 1);
});

test("turn metadata uses compact OpenCode-style durations and token counts", () => {
  assert.equal(formatDuration(865), "865ms");
  assert.equal(formatDuration(2_340), "2.3s");
  assert.equal(formatTokens(5_120), "5.1k");
});

test("working spinner scans continuously with a trailing shadow", () => {
  assert.deepEqual(createScannerFrames(4), [
    "■···",
    "▪■··",
    "•▪■·",
    "·•▪■",
    "··■▪",
    "·■▪•",
  ]);
});

function createInterruptEditor(isIdle: () => boolean) {
  const confirmation = new InterruptConfirmation(() => {}, 10_000);
  const keybindings = {
    matches: (data: string, action: string) =>
      data === "escape" && action === "app.interrupt",
  } as KeybindingsManager;
  let attachmentPaths: string[] = [];
  const editor = new OpenCodeEditor(
    { requestRender() {} } as TUI,
    {
      borderColor: (text: string) => text,
      selectList: {},
    } as EditorTheme,
    keybindings,
    {} as ExtensionAPI,
    { isIdle } as ExtensionContext,
    confirmation,
    (paths) => {
      attachmentPaths = paths;
    },
  );
  let interruptCount = 0;
  editor.onEscape = () => {
    interruptCount++;
  };

  return {
    editor,
    confirmation,
    getInterruptCount: () => interruptCount,
    getAttachmentPaths: () => attachmentPaths,
  };
}

test("requires a second interrupt keypress while the agent is active", () => {
  const { editor, confirmation, getInterruptCount } = createInterruptEditor(
    () => false,
  );

  editor.handleInput("escape");
  assert.equal(confirmation.isPending(), true);
  assert.equal(getInterruptCount(), 0);

  editor.handleInput("escape");
  assert.equal(confirmation.isPending(), false);
  assert.equal(getInterruptCount(), 1);
});

test("keeps idle interrupt behavior unchanged", () => {
  const { editor, confirmation, getInterruptCount } = createInterruptEditor(
    () => true,
  );

  editor.handleInput("escape");
  assert.equal(confirmation.isPending(), false);
  assert.equal(getInterruptCount(), 1);
});

test("expires interrupt confirmation and restores the normal footer prompt", async () => {
  let changes = 0;
  const confirmation = new InterruptConfirmation(() => changes++, 0);

  assert.equal(confirmation.request(), false);
  assert.equal(confirmation.isPending(), true);
  assert.equal(interruptPrompt(true), "again to interrupt");

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(confirmation.isPending(), false);
  assert.equal(changes, 2);
  assert.equal(interruptPrompt(false), "interrupt");
});

test("replaces editor borders with a centered left-edge panel and metadata row", () => {
  const cursor = "\x1b[7m \x1b[0m";
  const lines = layoutEditorPanel(
    ["─────", `${cursor}    `, "─────", "item "],
    12,
    10,
    "Build",
    {
      border: (text) => `\x1b[31m${text}\x1b[39m`,
      background: (text) => `\x1b[40m${text}\x1b[49m`,
      placeholder: (text) => `\x1b[2m${text}\x1b[22m`,
    },
    "Ask anything...",
  );

  assert.equal(lines.length, 6);
  assert.equal(visibleWidth(lines[0]!), 11);
  assert.match(lines[0]!, /^ /);
  assert.ok(lines[1]!.includes("Ask"));
  assert.ok(lines[3]!.includes("Build"));
  assert.ok(lines[5]!.includes("item"));
  assert.ok(lines.slice(0, 5).every((line) => !line.includes("\x1b[0m")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
});

test("turns pasted clipboard images into indexed attachment prompts", () => {
  const imagePath =
    "/var/folders/example/T/pi-clipboard-a8b67746-e8e4-4196-bb5e-f542fe3b45d3.png";
  const input = `can you inspect this?\n${imagePath}`;

  assert.deepEqual(findClipboardImagePaths(input), [imagePath]);
  const attachment = { source: imagePath, path: imagePath };
  assert.equal(
    formatClipboardAttachmentPrompt(input, [attachment]),
    `can you inspect this?\n[Image 1]\n\n<file name="${imagePath}"></file>`,
  );
  assert.equal(
    formatClipboardAttachmentPrompt("[Image 1] can you inspect this?", [
      attachment,
    ]),
    `[Image 1] can you inspect this?\n\n<file name="${imagePath}"></file>`,
  );
});

test("keeps image placeholders where they were pasted in the editor", () => {
  const { editor } = createInterruptEditor(() => true);

  editor.insertTextAtCursor("before ");
  editor.insertTextAtCursor("/tmp/image.png");
  editor.insertTextAtCursor("after");

  assert.equal(
    editor.getText().replaceAll("\u200b", ""),
    "before [Image 1] after",
  );
});

test("deletes an attachment placeholder atomically", () => {
  const { editor, getAttachmentPaths } = createInterruptEditor(() => true);

  editor.insertTextAtCursor("/tmp/image.png");
  editor.handleInput("\x7f");
  assert.equal(editor.getText().replaceAll("\u200b", ""), "[Image 1]");

  editor.handleInput("\x7f");

  assert.equal(editor.getText(), "");
  assert.deepEqual(getAttachmentPaths(), []);
});

test("does not reuse attachments for manually typed image placeholders", () => {
  const { editor, getAttachmentPaths } = createInterruptEditor(() => true);

  editor.insertTextAtCursor("/tmp/image.png");
  assert.deepEqual(getAttachmentPaths(), ["/tmp/image.png"]);

  editor.setText("");
  editor.insertTextAtCursor("[Image 1]");
  editor.handleInput(" ");

  assert.deepEqual(getAttachmentPaths(), []);
});

test("places multiple attachment tags inline", () => {
  const first = "/tmp/one.png";
  const second = "/tmp/two.png";

  assert.equal(
    formatClipboardAttachmentPrompt(`${first}\n${second}`, [
      { source: first, path: first },
      { source: second, path: second },
    ]),
    `[Image 1]\n[Image 2]\n\n<file name="${first}"></file> <file name="${second}"></file>`,
  );
});

test("recognizes shell-escaped image paths pasted from Finder", () => {
  const source =
    "/var/folders/example/TemporaryItems/Screenshot\\ 2026-08-19\\ at\\ 10.39.03 AM.png";
  const path =
    "/var/folders/example/TemporaryItems/Screenshot 2026-08-19 at 10.39.03 AM.png";
  const input = `${source} test`;

  assert.deepEqual(findImagePathReferences(input), [{ source, path }]);
  assert.equal(
    formatClipboardAttachmentPrompt(input, [{ source, path }]),
    `[Image 1] test\n\n<file name="${path}"></file>`,
  );
});

test("adds attachments inline to the editor panel", () => {
  const lines = layoutEditorPanel(
    ["─────", "test ", "─────"],
    80,
    80,
    "Build",
    {
      border: (text) => text,
      background: (text) => text,
      placeholder: (text) => text,
      attachmentBadge: (text) => `[${text.trim()}]`,
      attachmentFilename: (text) => text,
    },
    undefined,
    ["Screenshot 1.png", "Screenshot 2.png"],
  );

  const first = lines.findIndex((line) => line.includes("Screenshot 1.png"));
  const second = lines.findIndex((line) => line.includes("Screenshot 2.png"));
  assert.ok(first >= 0);
  assert.equal(second, first);
  assert.match(lines[first]!, /Screenshot 1\.png  \[file\] Screenshot 2\.png/);
});

test("renders sent image attachments without image placeholders", () => {
  const markdown =
    '[Image 1] test\n\n<file name="/tmp/Screenshot 2026-08-19 at 10.23.40 AM.png"></file>';

  assert.equal(
    renderAttachmentFiles(markdown, {
      badge: (text) => `<badge>${text}</badge>`,
      filename: (text) => `<filename>${text}</filename>`,
    }),
    "test\n\n<badge> file </badge><filename> Screenshot 2026-08-19 at 10.23.40 AM.png </filename>",
  );
});

test("leaves ordinary file blocks unchanged", () => {
  const markdown = '<file name="/tmp/notes.txt">keep me</file>';
  assert.equal(
    renderAttachmentFiles(markdown, {
      badge: (text) => text,
      filename: (text) => text,
    }),
    markdown,
  );
});

test("adds an accent border beside user messages without changing width", () => {
  const lines = addUserMessageBorder(
    ["\x1b]133;A\x07\x1b[40m abcde \x1b[49m", "\x1b[40m      \x1b[49m"],
    (text) => `\x1b[35m${text}\x1b[39m`,
  );

  assert.equal(visibleWidth(lines[0]!), 7);
  assert.equal(
    lines[0],
    "\x1b]133;A\x07\x1b[40m\x1b[35m│\x1b[39m abcde\x1b[49m",
  );
  assert.equal(visibleWidth(lines[1]!), 6);
  assert.equal(
    lines[1],
    `\x1b[40m\x1b[35m│\x1b[39m${"\u00a0".repeat(5)}\x1b[49m`,
  );
});

test("footer columns stay within narrow terminal widths", () => {
  const line = alignColumns(
    "~/project",
    "5.1k (1%)  shift+tab thinking  ctrl+l models",
    32,
  );
  assert.ok(visibleWidth(line) <= 32);
  assert.ok(line.includes("5.1k"));
});
