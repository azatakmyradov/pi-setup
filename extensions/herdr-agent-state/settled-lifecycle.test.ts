import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withSettledAgentLifecycle } from "./settled-lifecycle.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(eventName: string, handler: Handler) {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
  } as unknown as ExtensionAPI;
  const ctx = {} as ExtensionContext;

  async function emit(eventName: string, event: unknown): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) {
      await handler(event, ctx);
    }
  }

  return { api, ctx, emit, handlers };
}

test("defers managed agent_end handlers until agent_settled", async () => {
  const harness = createHarness();
  const adapted = withSettledAgentLifecycle(harness.api);
  const observed: AgentEndEvent[] = [];

  adapted.on("agent_end", (event) => {
    observed.push(event);
  });

  const firstEnd: AgentEndEvent = { type: "agent_end", messages: [] };
  const retryEnd: AgentEndEvent = { type: "agent_end", messages: [] };

  await harness.emit("agent_end", firstEnd);
  await harness.emit("agent_end", retryEnd);
  assert.deepEqual(observed, []);

  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.deepEqual(observed, [retryEnd]);
});

test("delegates unrelated lifecycle handlers unchanged", async () => {
  const harness = createHarness();
  const adapted = withSettledAgentLifecycle(harness.api);
  let starts = 0;

  adapted.on("agent_start", () => {
    starts += 1;
  });

  assert.equal(harness.handlers.get("agent_start")?.length, 1);
  await harness.emit("agent_start", { type: "agent_start" });
  assert.equal(starts, 1);
});

test("does not reuse an old agent_end event for a later settlement", async () => {
  const harness = createHarness();
  const adapted = withSettledAgentLifecycle(harness.api);
  const observed: AgentEndEvent[] = [];

  adapted.on("agent_end", (event) => {
    observed.push(event);
  });

  const completedEnd: AgentEndEvent = { type: "agent_end", messages: [] };
  await harness.emit("agent_end", completedEnd);
  await harness.emit("agent_settled", { type: "agent_settled" });
  await harness.emit("agent_settled", { type: "agent_settled" });

  assert.equal(observed[0], completedEnd);
  assert.deepEqual(observed[1], { type: "agent_end", messages: [] });
});
