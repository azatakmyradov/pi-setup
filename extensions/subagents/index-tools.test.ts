/**
 * Tool-handler tests for the extension entry point.
 *
 * The entry point is driven through a minimal `ExtensionAPI` double and a
 * runtime wired to scripted backends (the real three launch processes or
 * in-process model sessions), so these cover the handler logic: agent
 * resolution, unknown ids, send wording per steering capability, blocking vs
 * background spawns, and the spawn result budget.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
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

/** Settles one scripted run on demand, for the tests that need a live child. */
interface SettleControl {
  settle(finalText: string): void;
}

interface ScriptedBackendOptions {
  readonly name: BackendName;
  /** Mirrors `BackendCapabilities.steering`. */
  readonly steering?: boolean;
  /** Omit to keep the run active forever (for steering/queueing tests). */
  readonly finalText?: string;
  /** Every spawned task, in order, for asserting what the tool passed down. */
  readonly tasks?: SpawnTask[];
  /** One control per spawned session, in order. */
  readonly controls?: SettleControl[];
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
        let active = true;
        const settle = (finalText: string) => {
          active = false;
          Queue.offerUnsafe(events, {
            _tag: "RunSettled",
            outcome: { _tag: "Completed", finalText },
          });
        };
        options.controls?.push({ settle });
        Queue.offerUnsafe(events, { _tag: "RunStarted" });
        if (options.finalText !== undefined) settle(options.finalText);
        return {
          meta: Effect.succeed({
            backend: options.name,
            modelLabel: "test-model",
            sessionFilePath: "/tmp/subagents-test-session.jsonl",
          }),
          events: Stream.fromQueue(events),
          // Like the real backends: a follow-up to a settled run starts a new
          // run (RunStarted, then its own settlement); steering a live run
          // emits nothing extra.
          send: () =>
            Effect.sync(() => {
              if (active) return;
              active = true;
              Queue.offerUnsafe(events, { _tag: "RunStarted" });
              if (options.finalText !== undefined) settle(`${options.finalText} after follow-up`);
            }),
          interrupt: Effect.void,
        } satisfies SubagentSession;
      }),
  };
}

/** Long enough to blow the spawn result budget, with a unique first and last line. */
const LONG_OUTPUT = [
  "FIRST LINE OF THE REPORT",
  ...Array.from({ length: 4_000 }, (_, index) => `middle line ${index} ${"y".repeat(40)}`),
  "CONCLUSION: the answer is 42",
].join("\n");

// --- Extension double ----------------------------------------------------------

/**
 * The tool arguments these tests send. A union schema keeps the registered
 * definitions concretely typed (`ToolDefinition<typeof ToolCallSchema>`), which
 * is what lets one double stand in for every tool.
 */
const ToolCallSchema = Type.Union([
  Type.Object({
    prompt: Type.String(),
    name: Type.String(),
    agent: Type.Optional(Type.String()),
    harness: Type.Optional(Type.String()),
    background: Type.Optional(Type.Boolean()),
  }),
  Type.Object({ ids: Type.Array(Type.String()) }),
  Type.Object({
    id: Type.String(),
    prompt: Type.String(),
    background: Type.Optional(Type.Boolean()),
  }),
]);

type ToolCall = Static<typeof ToolCallSchema>;
/**
 * The subset of an extension event handler this double replays. The event
 * payload is `never` so every registered handler is assignable; the two hooks
 * the tests replay read only the context.
 */
type LifecycleHandler = (event: never, ctx: ExtensionContext) => void;
/** Only the members these tests use, so the double can hold every tool. */
type TestTool = Pick<ToolDefinition<typeof ToolCallSchema>, "name" | "execute" | "renderResult">;

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
  call(name: string, params: ToolCall, signal?: AbortSignal): Promise<string>;
  readonly piTasks: SpawnTask[];
  /** One control per spawned codex-backed run, in spawn order. */
  readonly codexControls: SettleControl[];
  /** Every follow-up message the extension pushed into the parent session. */
  readonly followUps: string[];
  /** Fire the parent's `agent_settled` hook, which flushes deferred results. */
  flushFollowUps(): void;
  dispose(): Promise<void>;
}

function createHarness(): Harness {
  const piTasks: SpawnTask[] = [];
  const codexControls: SettleControl[] = [];
  const followUps: string[] = [];
  const registry = Layer.sync(BackendRegistry, () => {
    const backends: SubagentBackend[] = [
      scriptedBackend({ name: "pi", finalText: "pi child report", tasks: piTasks }),
      scriptedBackend({ name: "claude", finalText: LONG_OUTPUT }),
      // No final text and no steering: a live Codex-like run, settled by the
      // test through its control when it needs the child to finish.
      scriptedBackend({ name: "codex", steering: false, controls: codexControls }),
    ];
    return new Map<BackendName, SubagentBackend>(
      backends.map((backend) => [backend.name, backend]),
    );
  });

  const tools = new Map<string, TestTool>();
  const messageRenderers = new Map<string, MessageRenderer>();
  // Only the two hooks that govern result delivery are replayed: session_start
  // (without it the extension treats every settlement as a shutdown) and
  // agent_settled (which flushes deferred follow-ups).
  const lifecycle = new Map<string, LifecycleHandler[]>();
  const pi: Partial<ExtensionAPI> = {
    events: { emit: () => {}, on: () => () => {} },
    // SAFETY: the double stores handlers by event name and replays them with
    // the session context below, which is all these two hooks read.
    on: ((event: string, handler: LifecycleHandler) => {
      lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]);
      return () => {
        lifecycle.set(
          event,
          (lifecycle.get(event) ?? []).filter((entry) => entry !== handler),
        );
      };
    }) as ExtensionAPI["on"],
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
    sendMessage: (message) => {
      followUps.push(Array.isArray(message.content) ? "" : message.content);
    },
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

  const partialContext: Partial<ExtensionToolContext> = {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    hasUI: false,
    // Never idle: a settled result is deferred rather than flushed on the
    // spot, so a test can assert what is still pending.
    isIdle: () => false,
  };
  // SAFETY: the tool handlers read only cwd, isProjectTrusted, model, and
  // modelRegistry; the last two are legitimately absent in a headless test.
  const ctx = partialContext as ExtensionToolContext;

  const emit = (event: string) => {
    // SAFETY: session_start and agent_settled are the only replayed hooks and
    // neither reads its event payload.
    const noEvent = undefined as never;
    for (const handler of lifecycle.get(event) ?? []) handler(noEvent, ctx);
  };
  emit("session_start");

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
    codexControls,
    followUps,
    flushFollowUps() {
      emit("agent_settled");
    },
    async call(name, params, signal) {
      const result = await tool(name).execute("call-1", params, signal, undefined, ctx);
      return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    },
    async dispose() {
      await created?.dispose();
    },
  };
}

/** Poll a condition the manager reaches asynchronously, with a hard cap. */
async function until(label: string, predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
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

    assert.match(text, /^## sa-1 "find fold" finished/);
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
    // Background: the codex double never settles, so a blocking spawn could
    // not return before the follow-up is sent.
    const spawned = await harness.call("subagent_spawn", {
      prompt: "Keep running",
      name: "codex child",
      harness: "codex",
      background: true,
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
    // The scripted pi backend settles at spawn time, so the blocking spawn
    // returns with the child already finished.
    await harness.call("subagent_spawn", { prompt: "Short task", name: "pi child" });

    const sent = await harness.call("subagent_send", {
      id: "sa-1",
      prompt: "One more thing",
    });
    // The restart blocks like a foreground spawn and returns the *restarted*
    // run's output — not the section the previous run already produced.
    assert.match(sent, /^## sa-1 "pi child" finished/);
    assert.match(sent, /pi child report after follow-up/);
  });
});

test("send with background: true restarts a settled child without waiting", async () => {
  await withHarness(async (harness) => {
    await harness.call("subagent_spawn", { prompt: "Short task", name: "pi child" });

    const sent = await harness.call("subagent_send", {
      id: "sa-1",
      prompt: "One more thing",
      background: true,
    });
    assert.match(sent, /^Restarted sa-1 "pi child" with a follow-up; it keeps its full prior/);
    assert.match(sent, /delivered to you as a message after you end your turn/);
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

test("the spawn output budget keeps the child's conclusion", async () => {
  await withHarness(async (harness) => {
    const text = await harness.call("subagent_spawn", {
      prompt: "Write a very long report",
      name: "long report",
      harness: "claude",
    });

    assert.match(text, /FIRST LINE OF THE REPORT/);
    assert.match(text, /CONCLUSION: the answer is 42/);
    assert.match(text, /full transcript in \/tmp\/subagents-test-session\.jsonl/);
    assert.ok(Buffer.byteLength(text, "utf8") <= 16 * 1_024);
  });
});

test("a foreground spawn returns the child's output as a section", async () => {
  await withHarness(async (harness) => {
    const text = await harness.call("subagent_spawn", { prompt: "Short task", name: "pi child" });

    assert.match(text, /^## sa-1 "pi child" finished/);
    assert.match(text, /pi child report/);
    // The blocking call held the wait interest, so the result was consumed
    // and must not also arrive as a follow-up message.
    harness.flushFollowUps();
    assert.deepEqual(harness.followUps, []);
  });
});

test("a background spawn returns immediately with the id", async () => {
  await withHarness(async (harness) => {
    // The codex double never settles on its own, so a blocking spawn would
    // hang here: returning at all proves the call did not wait.
    const text = await harness.call("subagent_spawn", {
      prompt: "Keep running",
      name: "codex child",
      harness: "codex",
      background: true,
    });

    assert.match(text, /^Spawned subagent sa-1 "codex child"/);
    assert.match(text, /delivered to you as a message after you end your turn/);
    assert.match(text, /Do not sleep, do not poll subagent_check in a loop/);
  });
});

test("an aborted foreground spawn detaches instead of failing", async () => {
  await withHarness(async (harness) => {
    const controller = new AbortController();
    const pending = harness.call(
      "subagent_spawn",
      { prompt: "Keep running", name: "codex child", harness: "codex" },
      controller.signal,
    );
    await until("the child to start", async () =>
      (await harness.call("subagent_list", { ids: [] })).includes("sa-1"),
    );
    controller.abort();

    const text = await pending;
    assert.match(text, /detached to the background/);
    assert.match(text, /Do not respawn it/);

    // The child kept running, and nothing consumed its result: it is
    // delivered as a follow-up once it settles.
    harness.codexControls[0]?.settle("late report");
    await until("the detached child's follow-up result", () => {
      harness.flushFollowUps();
      return harness.followUps.length > 0;
    });
    assert.match(harness.followUps[0] ?? "", /Subagent sa-1 "codex child" finished/);
    assert.match(harness.followUps[0] ?? "", /late report/);
  });
});

test("a refused spawn shows the reason under the failed row", async () => {
  await withHarness(async (harness) => {
    const renderResult = harness.tool("subagent_spawn").renderResult;
    assert.ok(renderResult);

    const component = renderResult(
      {
        content: [{ type: "text", text: "working_dir is not a directory: /nope" }],
        details: undefined,
      },
      { expanded: false, isPartial: false },
      plainTheme,
      {
        args: { prompt: "Map it", name: "Map extension architecture" },
        toolCallId: "call-1",
        invalidate: () => {},
        lastComponent: undefined,
        // No chat row: this asserts the error body alone, which the row above
        // it renders as "Failed".
        state: {},
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: true,
      },
    );

    assert.deepEqual(
      component.render(80).map((line) => line.trimEnd()),
      ["┃ working_dir is not a directory: /nope"],
    );
  });
});

test("a partial render of a blocking spawn keeps the slot under the row empty", async () => {
  await withHarness(async (harness) => {
    const renderResult = harness.tool("subagent_spawn").renderResult;
    assert.ok(renderResult);

    // What onUpdate streams while execute is still waiting for the child.
    const component = renderResult(
      {
        content: [{ type: "text", text: 'Waiting for sa-1 "pi child" — working…' }],
        details: { id: "sa-1", title: "pi child", status: "running", background: false },
      },
      { expanded: false, isPartial: true },
      plainTheme,
      {
        args: { prompt: "Map it", name: "Map extension architecture" },
        toolCallId: "call-1",
        invalidate: () => {},
        lastComponent: undefined,
        state: {},
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: true,
        expanded: false,
        showImages: false,
        isError: false,
      },
    );

    assert.deepEqual(component.render(80), []);
  });
});

test("a successful spawn keeps an empty result slot under the row", async () => {
  await withHarness(async (harness) => {
    const renderResult = harness.tool("subagent_spawn").renderResult;
    assert.ok(renderResult);

    const component = renderResult(
      { content: [{ type: "text", text: "Spawned subagent sa-1" }], details: { id: "sa-1" } },
      { expanded: false, isPartial: false },
      plainTheme,
      {
        args: { prompt: "Map it", name: "Map extension architecture" },
        toolCallId: "call-1",
        invalidate: () => {},
        lastComponent: undefined,
        state: {},
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: false,
      },
    );

    assert.deepEqual(component.render(80), []);
  });
});
