/**
 * Tool-handler tests for the extension entry point.
 *
 * The entry point is driven through a minimal `ExtensionAPI` double and a
 * runtime wired to scripted backends (the real three launch processes or
 * in-process model sessions), so these cover the handler logic: agent
 * resolution, unknown ids, send wording per steering capability, and the wait
 * output budget.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Cause, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import subagents from "./index.ts";
import { BackendRegistry, type SubagentBackend, type SubagentSession } from "./src/backend.ts";
import type { BackendName, SpawnTask, SubagentEvent } from "./src/domain.ts";
import { SubagentManagerLive } from "./src/manager.ts";
import type { SubagentRuntime } from "./src/runtime.ts";

// keyHint (used by the collapsed-result expand hint) reads the global theme.
initTheme("dark", false);

// --- Scripted backends ---------------------------------------------------------

interface ScriptedBackendOptions {
  readonly name: BackendName;
  /** Mirrors `BackendCapabilities.steering`. */
  readonly steering?: boolean;
  /** Omit to keep the run active forever (for steering/queueing tests). */
  readonly finalText?: string;
  /** Every spawned task, in order, for asserting what the tool passed down. */
  readonly tasks?: SpawnTask[];
}

function scriptedBackend(options: ScriptedBackendOptions): SubagentBackend {
  return {
    name: options.name,
    capabilities: {
      steering: options.steering ?? true,
      modelSelection: true,
      reasoningEffort: true,
    },
    available: Effect.succeed(true),
    spawn: (task) =>
      Effect.gen(function* () {
        options.tasks?.push(task);
        const events = yield* Queue.make<SubagentEvent, Cause.Done>();
        Queue.offerUnsafe(events, { _tag: "RunStarted" });
        if (options.finalText !== undefined) {
          Queue.offerUnsafe(events, {
            _tag: "RunSettled",
            outcome: { _tag: "Completed", finalText: options.finalText },
          });
        }
        return {
          meta: Effect.succeed({
            backend: options.name,
            modelLabel: "test-model",
            sessionFilePath: "/tmp/subagents-test-session.jsonl",
          }),
          events: Stream.fromQueue(events),
          send: () => Effect.void,
          interrupt: Effect.void,
        } satisfies SubagentSession;
      }),
  };
}

/** Long enough to blow the wait budget, with a unique first and last line. */
const LONG_OUTPUT = [
  "FIRST LINE OF THE REPORT",
  ...Array.from({ length: 4_000 }, (_, index) => `middle line ${index} ${"y".repeat(40)}`),
  "CONCLUSION: the answer is 42",
].join("\n");

// --- Extension double ----------------------------------------------------------

/**
 * The tool arguments these tests send. A union schema keeps the registered
 * definitions concretely typed (`ToolDefinition<typeof ToolCallSchema>`), which
 * is what lets one double stand in for all six tools.
 */
const ToolCallSchema = Type.Union([
  Type.Object({
    prompt: Type.String(),
    name: Type.String(),
    agent: Type.Optional(Type.String()),
    harness: Type.Optional(Type.String()),
  }),
  Type.Object({ ids: Type.Array(Type.String()) }),
  Type.Object({ id: Type.String(), prompt: Type.String() }),
]);

type ToolCall = Static<typeof ToolCallSchema>;
/** Only the members these tests use, so the double can hold every tool. */
type TestTool = Pick<ToolDefinition<typeof ToolCallSchema>, "name" | "execute">;

/** Plain-text themer: rendered previews are asserted on their content. */
// SAFETY: test double covering the only theme calls the collapsed renderer makes.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

interface Harness {
  tool(name: string): TestTool;
  /** The renderer registered for one custom message type. */
  messageRenderer(customType: string): MessageRenderer;
  /** Run a tool handler and return its text content. */
  call(name: string, params: ToolCall): Promise<string>;
  readonly piTasks: SpawnTask[];
  dispose(): Promise<void>;
}

function createHarness(): Harness {
  const piTasks: SpawnTask[] = [];
  const registry = Layer.sync(BackendRegistry, () => {
    const backends: SubagentBackend[] = [
      scriptedBackend({ name: "pi", finalText: "pi child report", tasks: piTasks }),
      scriptedBackend({ name: "claude", finalText: LONG_OUTPUT }),
      // No final text and no steering: a live Codex-like run.
      scriptedBackend({ name: "codex", steering: false }),
    ];
    return new Map<BackendName, SubagentBackend>(
      backends.map((backend) => [backend.name, backend]),
    );
  });

  const tools = new Map<string, TestTool>();
  const messageRenderers = new Map<string, MessageRenderer>();
  // Lifecycle hooks are not exercised: the tests drive the tool handlers and
  // dispose the runtime directly.
  const pi: Partial<ExtensionAPI> = {
    events: { emit: () => {}, on: () => () => {} },
    on: () => {},
    registerTool: (definition) => {
      // SAFETY: every tool registered here takes one of the three parameter
      // shapes in ToolCallSchema, which is exactly what the tests pass.
      tools.set(definition.name, definition as TestTool);
    },
    registerMessageRenderer: (customType, renderer) => {
      // SAFETY: the renderer is only ever called back with the message shape
      // this extension itself sends, which is what the tests construct.
      messageRenderers.set(customType, renderer as MessageRenderer);
    },
    registerEntryRenderer: () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    appendEntry: () => {},
    getThinkingLevel: () => "off",
  };

  let created: SubagentRuntime | undefined;
  // SAFETY: registration and the tool handlers touch only the members above;
  // every other ExtensionAPI member is absent, so a stray call throws instead
  // of silently passing.
  subagents(pi as ExtensionAPI, {
    createRuntime: () => {
      created = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
      return created;
    },
  });

  const partialContext: Partial<ExtensionContext> = {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
  };
  // SAFETY: the tool handlers read only cwd, isProjectTrusted, model, and
  // modelRegistry; the last two are legitimately absent in a headless test.
  const ctx = partialContext as ExtensionContext;

  const tool = (name: string) => {
    const found = tools.get(name);
    if (!found) throw new Error(`${name} was not registered`);
    return found;
  };

  return {
    tool,
    messageRenderer(customType) {
      const found = messageRenderers.get(customType);
      if (!found) throw new Error(`${customType} has no renderer`);
      return found;
    },
    piTasks,
    async call(name, params) {
      const result = await tool(name).execute("call-1", params, undefined, undefined, ctx);
      return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    },
    async dispose() {
      await created?.dispose();
    },
  };
}

async function withHarness(run: (harness: Harness) => Promise<void>) {
  const harness = createHarness();
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

// --- Tests ---------------------------------------------------------------------

test("registers every subagent tool", async () => {
  await withHarness(async (harness) => {
    for (const name of [
      "subagent_spawn",
      "subagent_wait",
      "subagent_cancel",
      "subagent_send",
      "subagent_check",
      "subagent_list",
    ]) {
      assert.equal(harness.tool(name).name, name);
    }
  });
});

test("a collapsed subagent result previews ten lines and names the real expand key", async () => {
  await withHarness(async (harness) => {
    const body = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const component = harness.messageRenderer("subagent-result")(
      {
        role: "custom",
        customType: "subagent-result",
        content: `Subagent sa-1 finished\n${body}`,
        display: true,
        details: { id: "sa-1", title: "Inspect tests", status: "done" },
        timestamp: 0,
      },
      { expanded: false, outputPad: 0 },
      plainTheme,
    );
    assert.ok(component);

    const lines = component.render(120).map((line) => line.trimEnd());
    // Header, then exactly PREVIEW_LINES rows whose last one is the lone cut
    // marker, then the expand hint built from the user's keybinding.
    assert.equal(lines.length, 12);
    assert.deepEqual(lines.slice(1, 11), [
      ...Array.from({ length: 9 }, (_, index) => `line ${index + 1}`),
      "…",
    ]);
    const hint = lines[11] ?? "";
    assert.match(hint, /expand/);
    assert.doesNotMatch(hint, /\(ctrl\+o to expand\)/);
  });
});

test('spawn with agent "explore" passes the definition\'s tools and system prompt', async () => {
  await withHarness(async (harness) => {
    const text = await harness.call("subagent_spawn", {
      prompt: "Find where the manager folds events",
      name: "find fold",
      agent: "explore",
    });

    assert.match(text, /agent explore/);
    assert.equal(harness.piTasks.length, 1);
    const task = harness.piTasks[0];
    assert.deepEqual(task?.tools, ["read", "grep", "find", "ls", "bash"]);
    assert.match(task?.systemPrompt ?? "", /read-only file-search specialist/);
    assert.equal(task?.agentName, "explore");
  });
});

test("spawn rejects an unknown agent name and lists the known ones", async () => {
  await withHarness(async (harness) => {
    await assert.rejects(
      harness.call("subagent_spawn", {
        prompt: "Do something",
        name: "bad agent",
        agent: "nope",
      }),
      /Unknown agent "nope"\. Known agents: general, explore/,
    );
    assert.equal(harness.piTasks.length, 0);
  });
});

test("send reports queueing when the harness cannot steer a running child", async () => {
  await withHarness(async (harness) => {
    const spawned = await harness.call("subagent_spawn", {
      prompt: "Keep running",
      name: "codex child",
      harness: "codex",
    });
    assert.match(spawned, /Spawned subagent sa-1/);

    const sent = await harness.call("subagent_send", {
      id: "sa-1",
      prompt: "Also check the tests",
    });
    assert.match(sent, /Queued for sa-1's next turn \(this harness cannot steer mid-run\)/);
  });
});

test("send restarts a settled child and keeps its context", async () => {
  await withHarness(async (harness) => {
    await harness.call("subagent_spawn", { prompt: "Short task", name: "pi child" });
    await harness.call("subagent_wait", { ids: ["sa-1"] });

    const sent = await harness.call("subagent_send", {
      id: "sa-1",
      prompt: "One more thing",
    });
    assert.match(sent, /Restarted sa-1 "pi child" with a follow-up; it keeps its full prior/);
    assert.match(sent, /subagent_wait\(ids: \["sa-1"\]\)/);
  });
});

test("send rejects an unknown id and lists the known ones", async () => {
  await withHarness(async (harness) => {
    await harness.call("subagent_spawn", { prompt: "Short task", name: "pi child" });
    await assert.rejects(
      harness.call("subagent_send", { id: "sa-99", prompt: "hello" }),
      /Unknown subagent id "sa-99"\. Known: sa-1\./,
    );
  });
});

test("the wait output budget keeps the child's conclusion", async () => {
  await withHarness(async (harness) => {
    await harness.call("subagent_spawn", {
      prompt: "Write a very long report",
      name: "long report",
      harness: "claude",
    });
    const text = await harness.call("subagent_wait", { ids: ["sa-1"] });

    assert.match(text, /FIRST LINE OF THE REPORT/);
    assert.match(text, /CONCLUSION: the answer is 42/);
    assert.match(text, /full transcript in \/tmp\/subagents-test-session\.jsonl/);
    assert.ok(Buffer.byteLength(text, "utf8") <= 48 * 1_024);
  });
});
