import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import herdrAgentName, {
  cheapestAvailableModel,
  generateAgentName,
  normalizeAgentName,
  parseModelGeneratedName,
} from "./index.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => unknown;

type ExecCall = {
  command: string;
  args: string[];
};

type HarnessOptions = {
  execCodes?: number[];
  models?: Model<Api>[];
  select?: (choices: string[]) => string | undefined;
  sessionName?: string;
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
    input: ["text"],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: 0,
      cacheWrite: 0,
    },
  } as Model<Api>;
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const execCalls: ExecCall[] = [];
  const notifications: string[] = [];
  const selections: string[][] = [];
  const assignedSessionNames: string[] = [];
  const execCodes = [...(options.execCodes ?? [])];
  let sessionName = options.sessionName;

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
      execCalls.push({ command, args });
      return {
        code: execCodes.shift() ?? 0,
        killed: false,
        stdout: "",
        stderr: "rename failed",
      };
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(name: string) {
      sessionName = name;
      assignedSessionNames.push(name);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    modelRegistry: {
      getAvailable() {
        return options.models ?? [];
      },
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      async select(_title: string, choices: string[]) {
        selections.push(choices);
        return options.select?.(choices);
      },
    },
  } as unknown as ExtensionCommandContext;

  async function emit(eventName: string, event: unknown): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) {
      await handler(event as never, ctx);
    }
  }

  async function runCommand(name: string): Promise<void> {
    const handler = commands.get(name);
    assert.ok(handler, `Command ${name} is registered`);
    await handler("", ctx);
  }

  return {
    api,
    assignedSessionNames,
    commands,
    emit,
    execCalls,
    handlers,
    notifications,
    runCommand,
    selections,
  };
}

const herdrEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
} satisfies NodeJS.ProcessEnv;
const emptyConfigPath = join(
  tmpdir(),
  `herdr-agent-name-test-${process.pid}-missing.json`,
);

test("generates a short random fallback name", () => {
  assert.match(generateAgentName(), /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
});

test("normalizes display names", () => {
  assert.equal(
    normalizeAgentName("  Refactor\n  auth\tmodule  "),
    "Refactor auth module",
  );
  assert.equal(normalizeAgentName("\u0000\n"), undefined);
  assert.equal(normalizeAgentName("x".repeat(60)), "x".repeat(48));
});

test("normalizes model output and adds a uniqueness suffix", () => {
  assert.equal(
    parseModelGeneratedName("`Fix Herdr agent naming`\nExtra", "ab12"),
    "fix-herdr-agent-naming-ab12",
  );
  assert.equal(parseModelGeneratedName("***", "ab12"), undefined);
});

test("finds the cheapest authenticated text model", () => {
  const expensive = fakeModel("anthropic", "large", 3, 15);
  const cheap = fakeModel("openai", "mini", 0.1, 0.4);
  assert.equal(cheapestAvailableModel([expensive, cheap]), cheap);
});

test("registers settings but no lifecycle handlers outside Herdr", () => {
  const harness = createHarness();
  herdrAgentName(harness.api, { env: {} });
  assert.equal(harness.handlers.size, 0);
  assert.ok(harness.commands.has("herdr-name-settings"));
});

test("selects and persists the naming model in extension settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-agent-name-"));
  const configPath = join(directory, "config.json");
  const models = [
    fakeModel("anthropic", "large", 3, 15),
    fakeModel("openai", "mini", 0.1, 0.4),
  ];
  const harness = createHarness({
    models,
    select: (choices) =>
      choices.find((choice) => choice.startsWith("openai/mini ·")),
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
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Use the selected model",
    });

    assert.match(
      harness.selections[0]?.[0] ?? "",
      /^Automatic \(cheapest: openai\/mini\)$/,
    );
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      model: "openai/mini",
    });
    assert.equal(configuredModel, "openai/mini");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates and persists a model-created name before the first agent start", async () => {
  const harness = createHarness();
  const generationCalls: Array<{ prompt: string; model: string }> = [];
  herdrAgentName(harness.api, {
    configPath: emptyConfigPath,
    env: herdrEnv,
    fallbackName: () => "unused-fallback-ab12",
    modelNameGenerator: async (prompt, _ctx, model) => {
      generationCalls.push({ prompt, model });
      return "fix-herdr-agent-names-ab12";
    },
  });

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Generate Herdr names with a cheap model",
  });
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Continue",
  });

  assert.deepEqual(generationCalls, [
    { prompt: "Generate Herdr names with a cheap model", model: "auto" },
  ]);
  assert.deepEqual(harness.assignedSessionNames, [
    "fix-herdr-agent-names-ab12",
  ]);
  assert.deepEqual(harness.execCalls, [
    {
      command: "herdr",
      args: ["agent", "rename", "w1:p2", "fix-herdr-agent-names-ab12"],
    },
  ]);
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

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Continue the task",
  });

  assert.equal(generated, false);
  assert.deepEqual(harness.assignedSessionNames, []);
  assert.deepEqual(harness.execCalls[0]?.args, [
    "agent",
    "rename",
    "w1:p2",
    "Refactor auth module",
  ]);
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

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Name this task",
  });

  assert.deepEqual(harness.assignedSessionNames, ["calm-otter-ab12"]);
  assert.deepEqual(harness.notifications, [
    "Could not generate Herdr agent name: model unavailable. Using a random name.",
  ]);
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

  assert.deepEqual(
    harness.execCalls.map((call) => call.args),
    [
      ["agent", "rename", "w1:p2", "Review API"],
      ["agent", "rename", "w1:p2", "--clear"],
    ],
  );
});

test("clears the generated label only when Pi quits", async () => {
  const harness = createHarness();
  herdrAgentName(harness.api, {
    env: herdrEnv,
    modelNameGenerator: async () => "calm-otter-ab12",
  });

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Name this task",
  });
  await harness.emit("session_shutdown", {
    type: "session_shutdown",
    reason: "reload",
  });
  await harness.emit("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });

  assert.deepEqual(
    harness.execCalls.map((call) => call.args),
    [
      ["agent", "rename", "w1:p2", "calm-otter-ab12"],
      ["agent", "rename", "w1:p2", "--clear"],
    ],
  );
});

test("reports failures and retries the rename", async () => {
  const harness = createHarness({ execCodes: [1, 0] });
  herdrAgentName(harness.api, {
    env: herdrEnv,
    modelNameGenerator: async () => "calm-otter-ab12",
  });

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Name this task",
  });
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "Continue",
  });

  assert.equal(harness.execCalls.length, 2);
  assert.deepEqual(harness.notifications, [
    "Could not rename Herdr agent: rename failed",
  ]);
});
