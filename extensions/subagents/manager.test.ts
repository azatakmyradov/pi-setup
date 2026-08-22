/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask, SubagentEvent } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerService,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(backends.map((backend) => [backend.name, backend]));
});

const createTestRuntime = () =>
  ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)));

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerService,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));

    const snap = await runTool(runtime, manager.spawn("claude", task("Say hello to the tests")));
    assert.equal(snap.status, "running");
    assert.equal(snap.origin, "model");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(done.finalText, /\[stub:claude\] completed: Say hello to the tests/);
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("per-spawn settlement handlers can replace default result delivery", async () => {
  await withManager(async (manager, runtime) => {
    const custom: Array<{ id: string; consumed: boolean }> = [];
    const defaults: string[] = [];
    manager.view.setOnSettled((snap) => defaults.push(snap.id));

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Use custom delivery"), {
        onSettled(settled, consumed) {
          custom.push({ id: settled.id, consumed });
          return true;
        },
      }),
    );
    await runTool(runtime, manager.waitFor([snap.id]));

    assert.deepEqual(custom, [{ id: snap.id, consumed: true }]);
    assert.deepEqual(defaults, []);
    assert.equal(manager.view.get(snap.id)?.status, "done");
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));

    const snap = await runTool(runtime, manager.spawn("codex", task("FAIL: blow up please")));
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.spawn("claude", task("Long running task")));
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [{ id: snap.id, title: "test", status: "error", cancelled: true }]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) => settled.push({ id: snap.id, origin: snap.origin }));

    const model = await runTool(runtime, manager.spawn("codex", task("model task")));
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("retained transcript text is bounded", async () => {
  await withManager(async (manager, runtime) => {
    const prompt = "x".repeat(80 * 1_024);
    const snap = await runTool(runtime, manager.spawn("claude", task(prompt)));
    await runTool(runtime, manager.waitFor([snap.id]));

    const userMessage = manager.view.get(snap.id)?.transcript.find((item) => item.kind === "user");
    assert.equal(userMessage?.kind, "user");
    if (userMessage?.kind === "user") {
      assert.equal(userMessage.text.length, 64 * 1_024);
    }
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach([1, 2, 3, 4], (n) => manager.spawn("codex", task(`Task ${n}`)), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(runtime, manager.spawn("claude", task("early finisher")));
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach([1, 2, 3, 4], (n) => manager.spawn("codex", task(`Task ${n}`)), {
        concurrency: "unbounded",
      }),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(runTool(runtime, manager.send(settled.id, "go again")), /Max 4 subagents/);
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.spawn("claude", task("First turn")));
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

// --- Compaction + explicit-null usage folding --------------------------------

function makeScriptedBackend(script: SubagentEvent[], endStream = true): SubagentBackend {
  return {
    name: "claude",
    capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.gen(function* () {
        const events = yield* Queue.make<SubagentEvent, Cause.Done>();
        for (const event of script) Queue.offerUnsafe(events, event);
        if (endStream) Queue.endUnsafe(events);
        return {
          meta: Effect.succeed({ backend: "claude" }),
          events: Stream.fromQueue(events),
          send: () => Effect.void,
          interrupt: Effect.void,
        };
      }),
  };
}

async function withScriptedManager(
  script: SubagentEvent[],
  run: (
    manager: SubagentManagerService,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
  endStream = true,
) {
  const registry = Layer.succeed(
    BackendRegistry,
    new Map<BackendName, SubagentBackend>([["claude", makeScriptedBackend(script, endStream)]]),
  );
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("compaction folds into the snapshot and explicit-null usage clears occupancy", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 150_000, contextWindow: 200_000 },
      { _tag: "CompactionStarted" },
      { _tag: "CompactionCompleted", tokensAfter: 14_000 },
      { _tag: "UsageChanged", tokens: null, contextWindow: 200_000 },
      { _tag: "RunSettled", outcome: { _tag: "Completed", finalText: "done" } },
    ],
    async (manager, runtime) => {
      const snap = await runTool(runtime, manager.spawn("claude", task("scripted")));
      await runTool(runtime, manager.waitFor([snap.id]));
      const done = manager.view.get(snap.id);
      assert.equal(done?.status, "done");
      assert.equal(done?.compactionCount, 1);
      assert.equal(done?.compacting, false);
      assert.equal(done?.usage.tokens, null);
    },
  );
});

test("compaction state is visible while the subagent is running", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 150_000, contextWindow: 200_000 },
      { _tag: "CompactionStarted" },
    ],
    async (manager, runtime) => {
      const snap = await runTool(runtime, manager.spawn("claude", task("scripted")));
      while (manager.view.get(snap.id)?.compacting !== true) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const mid = manager.view.get(snap.id);
      assert.equal(mid?.status, "running");
      assert.equal(mid?.compacting, true);
      assert.equal(mid?.compactionCount, 0);
    },
    false,
  );
});

test("CompactionCompleted without tokensAfter reports unknown occupancy", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 150_000, contextWindow: 200_000 },
      { _tag: "CompactionCompleted" },
      { _tag: "RunSettled", outcome: { _tag: "Completed", finalText: "done" } },
    ],
    async (manager, runtime) => {
      const snap = await runTool(runtime, manager.spawn("claude", task("scripted")));
      await runTool(runtime, manager.waitFor([snap.id]));
      const done = manager.view.get(snap.id);
      assert.equal(done?.compactionCount, 1);
      assert.equal(done?.usage.tokens, null);
    },
  );
});

test("UsageChanged without a tokens field keeps the previous occupancy", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 150_000, contextWindow: 200_000 },
      { _tag: "UsageChanged", contextWindow: 272_000 },
      { _tag: "RunSettled", outcome: { _tag: "Completed", finalText: "done" } },
    ],
    async (manager, runtime) => {
      const snap = await runTool(runtime, manager.spawn("claude", task("scripted")));
      await runTool(runtime, manager.waitFor([snap.id]));
      const done = manager.view.get(snap.id);
      assert.deepEqual(done?.usage, { tokens: 150_000, contextWindow: 272_000 });
    },
  );
});
