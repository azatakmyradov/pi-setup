import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import herdrAgentName, {
  buildNamingInput,
  cheapestAvailableModel,
  generateAgentName,
  messageText,
  namingModelCandidates,
  normalizeAgentName,
  parseModelGeneratedName,
  toAgentSlug,
} from "./index.ts";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => Promise<void> | void;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

type ExecCall = {
  command: string;
  args: string[];
};

type HarnessOptions = {
  execCodes?: number[];
  input?: (title: string, placeholder?: string) => string | undefined;
  models?: Model<Api>[];
  select?: (choices: string[]) => string | undefined;
  sessionName?: string;
  sessionEntries?: unknown[];
  /** Tab id reported by `herdr agent get`; null simulates a response without one. */
  tabId?: string | null;
};

function fakeModel(
  provider: string,
  id: string,
  inputCost: number,
  outputCost: number,
): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "anthropic-messages",
    baseUrl: "https://models.invalid",
    reasoning: false,
    input: ["text"],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
}

/** The extension only reads `prompt`, so the rest of the event carries neutral values. */
function beforeAgentStart(prompt: string): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt,
    systemPrompt: "",
    systemPromptOptions: { cwd: process.cwd() },
  };
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const execCalls: ExecCall[] = [];
  const notifications: string[] = [];
  const prompts: Array<{ title: string; placeholder?: string }> = [];
  const selections: string[][] = [];
  const assignedSessionNames: string[] = [];
  const execCodes = [...(options.execCodes ?? [])];
  let sessionName = options.sessionName;
  let staleMessage: string | undefined;

  function assertActive(): void {
    if (staleMessage) {
      throw new Error(staleMessage);
    }
  }

  // SAFETY: test double provides the four API members this extension uses
  // (`on`, `registerCommand`, `exec`, and the session-name accessors).
  const api = {
    on(eventName: string, handler: Handler) {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
    async exec(command: string, args: string[]) {
      assertActive();
      execCalls.push({ command, args });
      if (args[0] === "agent" && args[1] === "get") {
        const agent = options.tabId === null ? {} : { tab_id: options.tabId ?? "w1K:t2" };
        return {
          code: 0,
          killed: false,
          stdout: JSON.stringify({ id: "test", result: { agent }, type: "agent_info" }),
          stderr: "",
        };
      }
      return {
        code: execCodes.shift() ?? 0,
        killed: false,
        stdout: "",
        stderr: "rename failed",
      };
    },
    getSessionName() {
      assertActive();
      return sessionName;
    },
    setSessionName(name: string) {
      assertActive();
      sessionName = name;
      assignedSessionNames.push(name);
    },
  } as ExtensionAPI;

  // SAFETY: test double provides the model registry and UI members the naming
  // command and the lifecycle handlers read from the context.
  const ctx = {
    get modelRegistry() {
      assertActive();
      return {
        getAvailable() {
          return options.models ?? [];
        },
      };
    },
    sessionManager: {
      getEntries() {
        return options.sessionEntries ?? [];
      },
    },
    get ui() {
      assertActive();
      return {
        async input(title: string, placeholder?: string) {
          prompts.push({ title, placeholder });
          return options.input?.(title, placeholder);
        },
        notify(message: string) {
          notifications.push(message);
        },
        async select(_title: string, choices: string[]) {
          selections.push(choices);
          return options.select?.(choices);
        },
      };
    },
  } as ExtensionCommandContext;

  async function emit(eventName: string, event: ExtensionEvent): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) {
      await handler(event, ctx);
    }
  }

  async function runCommand(name: string, args: string = ""): Promise<void> {
    const handler = commands.get(name);
    assert.ok(handler, `Command ${name} is registered`);
    await handler(args, ctx);
  }

  return {
    api,
    assignedSessionNames,
    commands,
    emit,
    execCalls,
    handlers,
    notifications,
    prompts,
    runCommand,
    selections,
    setExternalSessionName(name: string | undefined) {
      sessionName = name;
    },
    invalidate() {
      staleMessage =
        "This extension ctx is stale after session replacement or reload. " +
        "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), " +
        "ctx.switchSession(), or ctx.reload().";
    },
  };
}

/** Args after the leading subcommand for every `herdr <agent|tab> rename ...` call. */
function cliArgs(harness: ReturnType<typeof createHarness>, kind: "agent" | "tab"): string[][] {
  return harness.execCalls
    .filter((call) => call.command === "herdr" && call.args[0] === kind)
    .filter((call) => !(kind === "agent" && call.args[1] === "get"))
    .map((call) => call.args.slice(1));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const herdrEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
} satisfies NodeJS.ProcessEnv;
const emptyConfigPath = join(tmpdir(), `herdr-agent-name-test-${process.pid}-missing.json`);

test("generates a short random fallback name", () => {
  assert.match(generateAgentName(), /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
});

test("normalizes display names", () => {
  assert.equal(normalizeAgentName("  Refactor\n  auth\tmodule  "), "Refactor auth module");
  assert.equal(normalizeAgentName("\u0000\n"), undefined);
  assert.equal(normalizeAgentName("x".repeat(60)), "x".repeat(48));
});

test("slugs agent names to what the Herdr CLI accepts", () => {
  assert.equal(toAgentSlug("Fix flaky auth tests"), "fix-flaky-auth-tests");
  assert.equal(toAgentSlug("  Review   API  "), "review-api");
  assert.equal(toAgentSlug("3d render pipeline"), "task-3d-render-pipeline");
  assert.equal(toAgentSlug("x".repeat(40)), "x".repeat(32));
  assert.equal(toAgentSlug("???"), undefined);
  assert.equal(toAgentSlug(undefined), undefined);
});

test("parses model output into a readable title", () => {
  assert.equal(
    parseModelGeneratedName("`Fix Herdr agent naming`\nExtra"),
    "Fix Herdr agent naming",
  );
  assert.equal(
    parseModelGeneratedName('  Refactor   auth module "soon" '),
    "Refactor auth module soon",
  );
  assert.equal(
    parseModelGeneratedName("one two three four five six seven"),
    "one two three four five",
  );
  assert.equal(parseModelGeneratedName("***"), undefined);
  assert.equal(parseModelGeneratedName(""), undefined);
});

test("finds the cheapest authenticated text model", () => {
  const expensive = fakeModel("anthropic", "large", 3, 15);
  const cheap = fakeModel("openai", "mini", 0.1, 0.4);
  assert.equal(cheapestAvailableModel([expensive, cheap]), cheap);
});

test("extracts plain text from message content", () => {
  assert.equal(messageText("hello"), "hello");
  assert.equal(
    messageText([
      { type: "text", text: "fix" },
      { type: "image", data: "png-bytes", mimeType: "image/png" },
      { type: "text", text: "login" },
    ]),
    "fix login",
  );
  // Non-text blocks contribute nothing.
  assert.equal(messageText([{ type: "thinking", thinking: "secret plan" }]), "");
});

const entryBase = { parentId: null, timestamp: "2025-01-01T00:00:00.000Z" } as const;

function userEntry(id: string, text: string): SessionMessageEntry {
  return {
    type: "message",
    ...entryBase,
    id,
    message: { role: "user", content: text, timestamp: 0 },
  };
}

function assistantEntry(id: string, parentId: string, text: string): SessionMessageEntry {
  return {
    type: "message",
    ...entryBase,
    id,
    parentId,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

test("builds naming input from recent conversation and the latest request", () => {
  const entries: SessionEntry[] = [
    userEntry("e1", "Investigate flaky auth tests"),
    assistantEntry("e2", "e1", "Looking at token refresh."),
    {
      type: "model_change",
      ...entryBase,
      id: "e3",
      parentId: "e2",
      provider: "anthropic",
      modelId: "test-model",
    },
    {
      type: "message",
      ...entryBase,
      id: "e4",
      parentId: "e3",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "ignored" }],
        isError: false,
        timestamp: 0,
      },
    },
  ];

  const input = buildNamingInput(entries, "now fix the retry loop");
  assert.match(input, /user: Investigate flaky auth tests/);
  assert.match(input, /assistant: Looking at token refresh\./);
  assert.doesNotMatch(input, /ignored/);
  assert.match(input, /Latest request:\nnow fix the retry loop/);

  // Without history, the prompt is used verbatim.
  assert.equal(buildNamingInput([], "fresh task"), "fresh task");
});

test("orders naming model candidates cheapest-first after the configured pick", () => {
  const configured = fakeModel("fireworks", "nemotron", 0.1, 0.4);
  const cheaper = fakeModel("openai", "mini", 0.05, 0.2);
  const expensive = fakeModel("anthropic", "large", 3, 15);
  const models = [expensive, configured, cheaper];

  assert.deepEqual(namingModelCandidates(models, "fireworks/nemotron"), [
    configured,
    cheaper,
    expensive,
  ]);
  // Automatic selection puts the cheapest first and never duplicates it.
  assert.deepEqual(namingModelCandidates(models, "auto"), [cheaper, configured, expensive]);
  // An unavailable configured model still leaves every model as a fallback.
  assert.deepEqual(namingModelCandidates(models, "missing/model"), [
    cheaper,
    configured,
    expensive,
  ]);
});

test("passes chat context to the naming model", async () => {
  const harness = createHarness({
    sessionEntries: [
      { type: "message", message: { role: "user", content: "Set up the migrations runner" } },
      { type: "message", message: { role: "assistant", content: "Done, schema applied." } },
    ],
  });
  const prompts: string[] = [];
  let resolveName: ((name: string) => void) | undefined;
  const generatedName = new Promise<string>((resolve) => {
    resolveName = resolve;
  });
  herdrAgentName(harness.api, {
    configPath: emptyConfigPath,
    env: herdrEnv,
    modelNameGenerator: async (prompt) => {
      prompts.push(prompt);
      return generatedName;
    },
  });

  await harness.emit("before_agent_start", beforeAgentStart("Add a rollback command"));
  await waitFor(() => prompts.length === 1, "background name generation did not start");

  assert.match(prompts[0] ?? "", /user: Set up the migrations runner/);
  assert.match(prompts[0] ?? "", /assistant: Done, schema applied\./);
  assert.match(prompts[0] ?? "", /Latest request:\nAdd a rollback command/);

  assert.ok(resolveName);
  resolveName("migrations-rollback-ab12");
  await waitFor(() => harness.assignedSessionNames.length === 1, "generated name was not assigned");
  assert.deepEqual(harness.assignedSessionNames, ["migrations-rollback-ab12"]);
});

test("registers settings but no lifecycle handlers outside Herdr", () => {
  const harness = createHarness();
  herdrAgentName(harness.api, { env: {} });
  assert.equal(harness.handlers.size, 0);
  assert.ok(harness.commands.has("herdr-name-settings"));
  assert.ok(harness.commands.has("herdr-rename"));
});

test("selects and persists the naming model in extension settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-agent-name-"));
  const configPath = join(directory, "config.json");
  const models = [fakeModel("anthropic", "large", 3, 15), fakeModel("openai", "mini", 0.1, 0.4)];
  const harness = createHarness({
    models,
    select: (choices) => choices.find((choice) => choice.startsWith("openai/mini ·")),
  });
  let configuredModel: string | undefined;

  try {
    herdrAgentName(harness.api, {
      configPath,
      env: herdrEnv,
      modelNameGenerator: async (_prompt, _ctx, model) => {
        configuredModel = model;
        return "selected-model-name-ab12";
      },
    });
    await harness.runCommand("herdr-name-settings");
    await harness.emit("before_agent_start", beforeAgentStart("Use the selected model"));

    assert.match(harness.selections[0]?.[0] ?? "", /^Automatic \(cheapest: openai\/mini\)$/);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      model: "openai/mini",
    });
    await waitFor(
      () => configuredModel === "openai/mini",
      "background generation did not use the configured model",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates and persists a model-created name without delaying agent start", async () => {
  const harness = createHarness();
  const generationCalls: Array<{ prompt: string; model: string }> = [];
  let resolveName: ((name: string) => void) | undefined;
  const generatedName = new Promise<string>((resolve) => {
    resolveName = resolve;
  });
  herdrAgentName(harness.api, {
    configPath: emptyConfigPath,
    env: herdrEnv,
    fallbackName: () => "unused-fallback-ab12",
    modelNameGenerator: async (prompt, _ctx, model) => {
      generationCalls.push({ prompt, model });
      return generatedName;
    },
  });

  await harness.emit(
    "before_agent_start",
    beforeAgentStart("Generate Herdr names with a cheap model"),
  );
  await waitFor(() => generationCalls.length === 1, "background name generation did not start");
  assert.deepEqual(harness.assignedSessionNames, []);
  assert.deepEqual(harness.execCalls, []);

  assert.ok(resolveName);
  resolveName("fix-herdr-agent-names-ab12");
  await waitFor(() => harness.assignedSessionNames.length === 1, "generated name was not assigned");
  await harness.emit("before_agent_start", beforeAgentStart("Continue"));

  assert.deepEqual(generationCalls, [
    { prompt: "Generate Herdr names with a cheap model", model: "auto" },
  ]);
  assert.deepEqual(harness.assignedSessionNames, ["fix-herdr-agent-names-ab12"]);
  assert.deepEqual(cliArgs(harness, "agent"), [["rename", "w1:p2", "fix-herdr-agent-names-ab12"]]);
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "fix-herdr-agent-names-ab12"]]);
});

test("uses an existing Pi session name without invoking the naming model", async () => {
  const harness = createHarness({ sessionName: "Refactor auth module" });
  let generated = false;
  herdrAgentName(harness.api, {
    env: herdrEnv,
    modelNameGenerator: async () => {
      generated = true;
      return "unused-name-ab12";
    },
  });

  await harness.emit("before_agent_start", beforeAgentStart("Continue the task"));

  assert.equal(generated, false);
  assert.deepEqual(harness.assignedSessionNames, []);
  assert.deepEqual(cliArgs(harness, "agent")[0], ["rename", "w1:p2", "refactor-auth-module"]);
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "Refactor auth module"]]);
});

test("falls back to a random name when model generation fails", async () => {
  const harness = createHarness();
  herdrAgentName(harness.api, {
    env: herdrEnv,
    fallbackName: () => "calm-otter-ab12",
    modelNameGenerator: async () => {
      throw new Error("model unavailable");
    },
  });

  await harness.emit("before_agent_start", beforeAgentStart("Name this task"));

  await waitFor(() => harness.assignedSessionNames.length === 1, "fallback name was not assigned");
  assert.deepEqual(harness.assignedSessionNames, ["calm-otter-ab12"]);
  assert.deepEqual(harness.notifications, [
    "Could not generate Herdr agent name: model unavailable. Using a random name.",
  ]);
});

test("does not overwrite an explicit name while generation is pending", async () => {
  const harness = createHarness();
  let resolveName: ((name: string) => void) | undefined;
  let generationFinished = false;
  const generatedName = new Promise<string>((resolve) => {
    resolveName = resolve;
  });
  herdrAgentName(harness.api, {
    env: herdrEnv,
    modelNameGenerator: async () => {
      const name = await generatedName;
      generationFinished = true;
      return name;
    },
  });

  await harness.emit("before_agent_start", beforeAgentStart("Name this task"));
  harness.setExternalSessionName("Manual name");
  await harness.emit("session_info_changed", {
    type: "session_info_changed",
    name: "Manual name",
  });

  assert.ok(resolveName);
  resolveName("generated-name-ab12");
  await waitFor(() => generationFinished, "background name generation did not finish");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.assignedSessionNames, []);
  assert.deepEqual(cliArgs(harness, "agent"), [["rename", "w1:p2", "manual-name"]]);
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "Manual name"]]);
});

test("keeps Herdr synchronized with explicit session name changes", async () => {
  const harness = createHarness();
  herdrAgentName(harness.api, { env: herdrEnv });

  await harness.emit("session_info_changed", {
    type: "session_info_changed",
    name: "Review API",
  });
  await harness.emit("session_info_changed", {
    type: "session_info_changed",
    name: undefined,
  });

  assert.deepEqual(cliArgs(harness, "agent"), [
    ["rename", "w1:p2", "review-api"],
    ["rename", "w1:p2", "--clear"],
  ]);
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "Review API"]]);
});

test("clears the generated label only when Pi quits", async () => {
  const harness = createHarness();
  herdrAgentName(harness.api, {
    env: herdrEnv,
    modelNameGenerator: async () => "calm-otter-ab12",
  });

  await harness.emit("before_agent_start", beforeAgentStart("Name this task"));
  await waitFor(
    () => harness.assignedSessionNames.length === 1,
    "generated name was not assigned before shutdown",
  );
  await harness.emit("session_shutdown", {
    type: "session_shutdown",
    reason: "reload",
  });
  await harness.emit("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });

  assert.deepEqual(cliArgs(harness, "agent"), [
    ["rename", "w1:p2", "calm-otter-ab12"],
    ["rename", "w1:p2", "--clear"],
  ]);
  // Clearing on quit only affects the agent entry; the tab keeps its label.
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "calm-otter-ab12"]]);
});

test("survives ctx invalidation while background name generation is pending", async () => {
  const harness = createHarness();
  let rejectGeneration: ((error: Error) => void) | undefined;
  herdrAgentName(harness.api, {
    configPath: emptyConfigPath,
    env: herdrEnv,
    fallbackName: () => "calm-otter-ab12",
    modelNameGenerator: () =>
      new Promise((_resolve, reject) => {
        rejectGeneration = reject;
      }),
  });

  await harness.emit("before_agent_start", beforeAgentStart("Name this task"));
  await waitFor(() => rejectGeneration !== undefined, "background name generation did not start");

  // Session replacement/reload: the runner invalidates the captured pi and ctx.
  harness.invalidate();

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (error: Error) => {
    unhandledRejections.push(error);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    assert.ok(rejectGeneration);
    rejectGeneration(new Error("model unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.deepEqual(unhandledRejections, []);
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.assignedSessionNames, []);
});

test("reports failures and retries the rename", async () => {
  const harness = createHarness({ execCodes: [1] });
  herdrAgentName(harness.api, {
    env: herdrEnv,
    modelNameGenerator: async () => "calm-otter-ab12",
  });

  await harness.emit("before_agent_start", beforeAgentStart("Name this task"));
  await waitFor(() => harness.notifications.length === 1, "rename failure was not reported");

  await harness.emit("before_agent_start", beforeAgentStart("Continue"));
  await waitFor(
    () => cliArgs(harness, "agent").length === 2,
    "failed Herdr rename was not retried",
  );

  assert.deepEqual(cliArgs(harness, "agent"), [
    ["rename", "w1:p2", "calm-otter-ab12"],
    ["rename", "w1:p2", "calm-otter-ab12"],
  ]);
  // The tab label was set independently of the failing agent rename.
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "calm-otter-ab12"]]);
  assert.deepEqual(harness.notifications, ["Could not rename Herdr agent: rename failed"]);
});

test("resolves the tab id once and reuses it across renames", async () => {
  const harness = createHarness({ sessionName: "Review API" });
  herdrAgentName(harness.api, { env: herdrEnv });

  await harness.emit("before_agent_start", beforeAgentStart("First prompt"));
  await harness.emit("before_agent_start", beforeAgentStart("Second prompt"));

  const lookups = harness.execCalls.filter(
    (call) => call.args[0] === "agent" && call.args[1] === "get",
  );
  assert.equal(lookups.length, 1);
});

test("still renames the agent when the tab id cannot be resolved", async () => {
  const harness = createHarness({ sessionName: "Review API", tabId: null });
  herdrAgentName(harness.api, { env: herdrEnv });

  await harness.emit("before_agent_start", beforeAgentStart("Continue the task"));

  assert.deepEqual(cliArgs(harness, "agent"), [["rename", "w1:p2", "review-api"]]);
  assert.deepEqual(cliArgs(harness, "tab"), []);
  assert.match(harness.notifications[0] ?? "", /Could not find the Herdr tab to rename/);
});

test("renames the tab from a command argument", async () => {
  const harness = createHarness({ sessionName: "old name ab12" });
  herdrAgentName(harness.api, { env: herdrEnv });

  await harness.runCommand("herdr-rename", "Fix login flow");

  assert.deepEqual(harness.prompts, []);
  assert.deepEqual(harness.assignedSessionNames, ["Fix login flow"]);
  assert.deepEqual(cliArgs(harness, "agent"), [["rename", "w1:p2", "fix-login-flow"]]);
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "Fix login flow"]]);
});

test("prompts for a tab name when no argument is given", async () => {
  const harness = createHarness({
    input: () => "Review API clients",
    sessionName: "old name ab12",
  });
  herdrAgentName(harness.api, { env: herdrEnv });

  await harness.runCommand("herdr-rename");

  assert.deepEqual(harness.prompts, [
    { title: "Rename Herdr agent:", placeholder: "old name ab12" },
  ]);
  assert.deepEqual(harness.assignedSessionNames, ["Review API clients"]);
  assert.deepEqual(cliArgs(harness, "agent"), [["rename", "w1:p2", "review-api-clients"]]);
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "Review API clients"]]);
});

test("keeps the current name when the prompt is dismissed or blank", async () => {
  const harness = createHarness({ input: () => undefined });
  herdrAgentName(harness.api, { env: herdrEnv });
  await harness.runCommand("herdr-rename");

  const blankHarness = createHarness({ input: () => "   " });
  herdrAgentName(blankHarness.api, { env: herdrEnv });
  await blankHarness.runCommand("herdr-rename");

  assert.deepEqual(harness.assignedSessionNames, []);
  assert.deepEqual(harness.execCalls, []);
  assert.deepEqual(blankHarness.assignedSessionNames, []);
  assert.deepEqual(blankHarness.execCalls, []);
  assert.deepEqual(blankHarness.notifications, ["Herdr agent name unchanged."]);
});

test("rejects unusable rename input without contacting Herdr", async () => {
  const harness = createHarness({ sessionName: "old name ab12" });
  herdrAgentName(harness.api, { env: herdrEnv });

  await harness.runCommand("herdr-rename", "\u0000\n");

  assert.deepEqual(harness.assignedSessionNames, []);
  assert.deepEqual(harness.execCalls, []);
  assert.deepEqual(harness.notifications, [
    "Could not rename Herdr agent: that name is not usable.",
  ]);
});

test("manual command rename wins over pending automatic generation", async () => {
  const harness = createHarness();
  let resolveName: ((name: string) => void) | undefined;
  let generationFinished = false;
  let generationStarted = false;
  herdrAgentName(harness.api, {
    env: herdrEnv,
    modelNameGenerator: () =>
      new Promise<string>((resolve) => {
        generationStarted = true;
        resolveName = resolve;
      }).then((name) => {
        generationFinished = true;
        return name;
      }),
  });

  await harness.emit(
    "before_agent_start",
    beforeAgentStart("Start work before generation settles"),
  );
  await waitFor(() => generationStarted, "background name generation did not start");
  await harness.runCommand("herdr-rename", "Manual choice");
  assert.ok(resolveName);
  resolveName("generated-name-ab12");
  await waitFor(() => generationFinished, "background name generation did not finish");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.assignedSessionNames, ["Manual choice"]);
  assert.deepEqual(cliArgs(harness, "agent"), [["rename", "w1:p2", "manual-choice"]]);
  assert.deepEqual(cliArgs(harness, "tab"), [["rename", "w1K:t2", "Manual choice"]]);
});

test("outside Herdr, manual rename only updates the Pi session name", async () => {
  const harness = createHarness();
  herdrAgentName(harness.api, { env: {} });

  await harness.runCommand("herdr-rename", "Local label");

  assert.deepEqual(harness.assignedSessionNames, ["Local label"]);
  assert.deepEqual(harness.execCalls, []);
});
