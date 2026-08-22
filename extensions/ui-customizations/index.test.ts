import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import {
  addUserMessageBorder,
  alignColumns,
  createClipboardAttachmentInputHandler,
  createScannerFrames,
  DraftAttachmentRegistry,
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
  stripAttachmentTracking,
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
  assert.deepEqual(createScannerFrames(4), ["■···", "▪■··", "•▪■·", "·•▪■", "··■▪", "·■▪•"]);
});

function createInterruptEditor(isIdle: () => boolean, registry = new DraftAttachmentRegistry()) {
  const confirmation = new InterruptConfirmation(() => {}, 10_000);
  // SAFETY: test double resolving only the three actions the editor asks about.
  const keybindings = {
    matches: (data: string, action: string) =>
      (data === "escape" && action === "app.interrupt") ||
      (data === "\r" && action === "tui.input.submit") ||
      (data === "alt+enter" && action === "app.message.followUp"),
  } as KeybindingsManager;
  let attachmentPaths: string[] = [];
  const editor = new OpenCodeEditor(
    // SAFETY: test double providing the two TUI members the editor uses.
    {
      requestRender() {},
      terminal: { rows: 40, columns: 80 },
    } as TUI,
    // SAFETY: test double providing the editor theme's border and list colors.
    {
      borderColor: (text: string) => text,
      selectList: {},
    } as EditorTheme,
    keybindings,
    // SAFETY: test double answering the one extension query the editor makes.
    { getThinkingLevel: () => "off" } as ExtensionAPI,
    // SAFETY: test double providing the idle probe and the plain-text themer the
    // editor renders through.
    {
      isIdle,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          inverse: (text: string) => text,
          bold: (text: string) => text,
        },
      },
    } as ExtensionContext,
    confirmation,
    registry,
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
    registry,
  };
}

async function createTestImage(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-attachment-test-"));
  const path = join(directory, "image.png");
  await writeFile(
    path,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return { path, cleanup: () => rm(directory, { recursive: true }) };
}

test("requires a second interrupt keypress while the agent is active", () => {
  const { editor, confirmation, getInterruptCount } = createInterruptEditor(() => false);

  editor.handleInput("escape");
  assert.equal(confirmation.isPending(), true);
  assert.equal(getInterruptCount(), 0);

  editor.handleInput("escape");
  assert.equal(confirmation.isPending(), false);
  assert.equal(getInterruptCount(), 1);
});

test("keeps idle interrupt behavior unchanged", () => {
  const { editor, confirmation, getInterruptCount } = createInterruptEditor(() => true);

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

test("hides attachment tracking characters from the rendered editor", async (t) => {
  const image = await createTestImage();
  t.after(image.cleanup);
  const { editor } = createInterruptEditor(() => true);

  editor.insertTextAtCursor(image.path);

  const internalText = editor.getText();
  assert.match(internalText, /\u{e0001}/u);
  assert.match(internalText, /\u{e007f}/u);

  const rendered = editor.render(80).join("\n");
  assert.match(rendered, /\[Image 1\]/);
  assert.doesNotMatch(rendered, /[\u{e0000}-\u{e007f}]/u);
});

test("turns pasted clipboard images into indexed attachment prompts", () => {
  const imagePath = "/var/folders/example/T/pi-clipboard-a8b67746-e8e4-4196-bb5e-f542fe3b45d3.png";
  const input = `can you inspect this?\n${imagePath}`;

  assert.deepEqual(findClipboardImagePaths(input), [imagePath]);
  const attachment = { source: imagePath, path: imagePath };
  assert.equal(
    formatClipboardAttachmentPrompt(input, [attachment]),
    `can you inspect this?\n[Image 1]\n\n<file name="${imagePath}"></file>`,
  );
  assert.equal(
    formatClipboardAttachmentPrompt("[Image 1] can you inspect this?", [attachment]),
    `[Image 1] can you inspect this?\n\n<file name="${imagePath}"></file>`,
  );
});

test("submits an image through Pi's deferred idle path", async (t) => {
  const image = await createTestImage();
  t.after(image.cleanup);
  const { editor, registry } = createInterruptEditor(() => true);
  const handleInput = createClipboardAttachmentInputHandler(registry);
  const submitted = new Promise<Awaited<ReturnType<typeof handleInput>>>((resolve) => {
    editor.onSubmit = (text) => {
      queueMicrotask(() => {
        void handleInput({
          type: "input",
          text,
          source: "interactive",
        }).then(resolve);
      });
    };
  });

  editor.insertTextAtCursor(image.path);
  editor.insertTextAtCursor("inspect /tmp/opencode");
  editor.handleInput("\r");

  assert.equal(editor.getText(), "");
  const result = await submitted;
  assert.equal(result.action, "transform");
  if (result.action !== "transform") return;
  assert.ok(result.text.startsWith("[Image 1] inspect /tmp/opencode"));
  assert.ok(result.text.includes(`<file name="${image.path}">`));
  assert.equal(stripAttachmentTracking(result.text), result.text);
  assert.equal(result.images?.length, 1);
});

test("submits an image immediately while the draft is still visible", async (t) => {
  const image = await createTestImage();
  t.after(image.cleanup);
  const { editor, registry } = createInterruptEditor(() => true);
  const handleInput = createClipboardAttachmentInputHandler(registry);

  editor.insertTextAtCursor(image.path);
  const draft = editor.getText();
  const result = await handleInput({
    type: "input",
    text: draft,
    source: "interactive",
  });

  assert.equal(editor.getText(), draft);
  assert.equal(result.action, "transform");
  if (result.action !== "transform") return;
  assert.equal(result.images?.length, 1);
  assert.ok(result.text.includes(`<file name="${image.path}">`));
});

test("captures an image synchronously inside the streaming submit callback", async (t) => {
  const image = await createTestImage();
  t.after(image.cleanup);
  const { editor, registry } = createInterruptEditor(() => false);
  const handleInput = createClipboardAttachmentInputHandler(registry);
  const submitted = new Promise<Awaited<ReturnType<typeof handleInput>>>((resolve) => {
    editor.onSubmit = (text) => {
      void handleInput({
        type: "input",
        text,
        source: "interactive",
        streamingBehavior: "steer",
      }).then(resolve);
    };
  });

  editor.insertTextAtCursor(image.path);
  editor.handleInput("\r");

  assert.equal(editor.getText(), "");
  const result = await submitted;
  assert.equal(result.action, "transform");
  if (result.action !== "transform") return;
  assert.equal(result.images?.length, 1);
  assert.ok(result.text.includes(`<file name="${image.path}">`));
});

test("preserves attachments when the follow-up action clears the editor", async (t) => {
  const image = await createTestImage();
  t.after(image.cleanup);
  const { editor, registry } = createInterruptEditor(() => false);
  const handleInput = createClipboardAttachmentInputHandler(registry);
  const submitted = new Promise<Awaited<ReturnType<typeof handleInput>>>((resolve) => {
    editor.onAction("app.message.followUp", () => {
      const text = editor.getText().trim();
      editor.setText("");
      queueMicrotask(() => {
        void handleInput({
          type: "input",
          text,
          source: "interactive",
          streamingBehavior: "followUp",
        }).then(resolve);
      });
    });
  });

  editor.insertTextAtCursor(image.path);
  editor.handleInput("alt+enter");

  assert.equal(editor.getText(), "");
  const result = await submitted;
  assert.equal(result.action, "transform");
  if (result.action !== "transform") return;
  assert.equal(result.images?.length, 1);
  assert.ok(result.text.includes(`<file name="${image.path}">`));
});

test("keeps image placeholders where they were pasted in the editor", () => {
  const { editor } = createInterruptEditor(() => true);

  editor.insertTextAtCursor("before ");
  editor.insertTextAtCursor("/tmp/image.png");
  editor.insertTextAtCursor("after");

  assert.equal(stripAttachmentTracking(editor.getText()), "before [Image 1] after");
});

test("deletes an attachment placeholder atomically", () => {
  const { editor, getAttachmentPaths } = createInterruptEditor(() => true);

  editor.insertTextAtCursor("before ");
  editor.insertTextAtCursor("/tmp/image.png");
  editor.handleInput("\x7f");
  assert.equal(stripAttachmentTracking(editor.getText()), "before [Image 1]");

  editor.handleInput("\x7f");

  assert.equal(editor.getText(), "before ");
  assert.deepEqual(getAttachmentPaths(), []);

  editor.handleInput("\x1f");
  assert.equal(editor.getText(), "before [Image 1]");
  assert.equal(stripAttachmentTracking(editor.getText()), editor.getText());
  assert.deepEqual(getAttachmentPaths(), []);

  editor.handleInput("\x1f");
  assert.equal(editor.getText(), "before [Image 1] ");
  editor.handleInput("\x1f");
  assert.equal(editor.getText(), "before ");
});

function paste(editor: OpenCodeEditor, text: string): void {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

const LARGE_PASTE_A = Array.from({ length: 12 }, (_, index) => `alpha line ${index}`).join("\n");
const LARGE_PASTE_B = Array.from({ length: 12 }, (_, index) => `beta line ${index}`).join("\n");

test("expands a collapsed paste in place when the same text is pasted twice", () => {
  const { editor } = createInterruptEditor(() => true);

  paste(editor, `prefix ${LARGE_PASTE_A}`);
  const collapsed = editor.getText();
  assert.match(collapsed, /\[paste #1 \+\d+ lines\]/);

  paste(editor, `prefix ${LARGE_PASTE_A}`);

  assert.equal(editor.getText(), `prefix ${LARGE_PASTE_A}`);
  const cursor = editor.getCursor();
  assert.equal(cursor.line, 11);
  assert.equal(cursor.col, "alpha line 11".length);

  editor.handleInput("\x1f");
  assert.equal(editor.getText(), collapsed);
});

test("does not expand when a different paste separates identical ones", () => {
  const { editor } = createInterruptEditor(() => true);

  paste(editor, LARGE_PASTE_A);
  paste(editor, LARGE_PASTE_B);
  paste(editor, LARGE_PASTE_A);

  assert.match(editor.getText(), /\[paste #1 \+\d+ lines\]/);
  assert.match(editor.getText(), /\[paste #2 \+\d+ lines\]/);
});

test("keeps small double pastes duplicating instead of expanding", () => {
  const { editor } = createInterruptEditor(() => true);

  paste(editor, "hello");
  paste(editor, "hello");

  assert.equal(editor.getText(), "hellohello");
});

test("resets duplicate detection after ordinary keystrokes", () => {
  const { editor } = createInterruptEditor(() => true);

  paste(editor, LARGE_PASTE_A);
  editor.handleInput("x");
  paste(editor, LARGE_PASTE_A);

  assert.match(editor.getText(), /\[paste #1 \+\d+ lines\]/);
  assert.match(editor.getText(), /\[paste #2 \+\d+ lines\]/);
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

test("fails closed when an ordinary clear is undone", () => {
  const { editor, getAttachmentPaths } = createInterruptEditor(() => true);
  editor.insertTextAtCursor("/tmp/image.png");

  editor.setText("");
  editor.handleInput("\x1f");

  assert.equal(editor.getText(), "[Image 1] ");
  assert.equal(stripAttachmentTracking(editor.getText()), editor.getText());
  assert.deepEqual(getAttachmentPaths(), []);
});

test("fails closed when an editor recreates a consumed marker", () => {
  const registry = new DraftAttachmentRegistry();
  const { editor } = createInterruptEditor(() => true, registry);
  editor.insertTextAtCursor("/tmp/image.png");
  const submitted = editor.getText().trim();
  registry.capture(submitted);

  const recreated = createInterruptEditor(() => true, registry);
  recreated.editor.setText(submitted);
  assert.equal(recreated.editor.getText(), "[Image 1]");

  recreated.editor.handleInput(" ");
  assert.equal(recreated.editor.getText(), "[Image 1] ");
  assert.deepEqual(recreated.getAttachmentPaths(), []);
});

test("fails closed when history restores a consumed marker", () => {
  const registry = new DraftAttachmentRegistry();
  const { editor } = createInterruptEditor(() => true, registry);
  editor.insertTextAtCursor("/tmp/image.png");
  const submitted = editor.getText().trim();
  editor.addToHistory(submitted);
  registry.capture(submitted);
  editor.setText("");

  editor.handleInput("\x1b[A");

  assert.equal(editor.getText(), "[Image 1]");
});

test("strips malformed invisible attachment tracking", async () => {
  const registry = new DraftAttachmentRegistry();
  const { editor } = createInterruptEditor(() => true, registry);
  const handleInput = createClipboardAttachmentInputHandler(registry);
  editor.insertTextAtCursor("/tmp/image.png");
  const malformed = editor.getText().trim().slice(0, -2);

  const result = await handleInput({
    type: "input",
    text: malformed,
    source: "interactive",
  });

  assert.equal(result.action, "transform");
  if (result.action !== "transform") return;
  assert.equal(result.text, "[Image 1]");
  assert.equal(stripAttachmentTracking(result.text), result.text);
});

test("keeps missing temporary image files as plain paths", async () => {
  const missing = join(tmpdir(), `missing-pi-attachment-${process.pid}-${Date.now()}.png`);
  const { editor, registry } = createInterruptEditor(() => true);
  const handleInput = createClipboardAttachmentInputHandler(registry);
  editor.insertTextAtCursor(missing);

  const result = await handleInput({
    type: "input",
    text: editor.getText().trim(),
    source: "interactive",
  });

  assert.equal(result.action, "transform");
  if (result.action !== "transform") return;
  assert.equal(result.text, missing);
  assert.equal(result.images, undefined);
});

test("attaches multiple images inserted at different positions", async (t) => {
  const first = await createTestImage();
  const second = await createTestImage();
  t.after(first.cleanup);
  t.after(second.cleanup);
  const { editor, registry } = createInterruptEditor(() => true);
  const handleInput = createClipboardAttachmentInputHandler(registry);

  editor.insertTextAtCursor(first.path);
  editor.insertTextAtCursor("between ");
  editor.insertTextAtCursor(second.path);
  const result = await handleInput({
    type: "input",
    text: editor.getText(),
    source: "interactive",
  });

  assert.equal(result.action, "transform");
  if (result.action !== "transform") return;
  assert.ok(result.text.startsWith("[Image 1] between [Image 2]"));
  assert.ok(
    result.text.endsWith(`<file name="${first.path}"></file> <file name="${second.path}"></file>`),
  );
  assert.equal(result.images?.length, 2);
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
  const path = "/var/folders/example/TemporaryItems/Screenshot 2026-08-19 at 10.39.03 AM.png";
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
  assert.equal(lines[0], "\x1b]133;A\x07\x1b[40m\x1b[35m│\x1b[39m abcde\x1b[49m");
  assert.equal(visibleWidth(lines[1]!), 6);
  assert.equal(lines[1], `\x1b[40m\x1b[35m│\x1b[39m${"\u00a0".repeat(5)}\x1b[49m`);
});

test("footer columns stay within narrow terminal widths", () => {
  const line = alignColumns("~/project", "5.1k (1%)  shift+tab thinking  ctrl+l models", 32);
  assert.ok(visibleWidth(line) <= 32);
  assert.ok(line.includes("5.1k"));
});
