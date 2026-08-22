import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentSession,
  AgentSessionEventListener,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  agentFailure,
  createFirstResponseWatchdog,
  guardWorkflowChildTools,
  latestAssistantOutcome,
  makeStructuredOutputTool,
  recordToolExecutionTiming,
  transcriptFromMessages,
  type ToolExecutionTiming,
} from "./runner.ts";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

type AssistantMessage = Extract<AgentSession["messages"][number], { role: "assistant" }>;

function assistantMessage(
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: zeroUsage,
    stopReason,
    errorMessage,
    timestamp: 1_000,
  };
}

test("latest assistant outcome captures a terminal assistant error", () => {
  const outcome = latestAssistantOutcome([
    assistantMessage("error", "Stream ended without finish_reason"),
  ]);

  assert.deepEqual(outcome, {
    stopReason: "error",
    errorMessage: "Stream ended without finish_reason",
  });
  assert.equal(agentFailure(outcome), "Stream ended without finish_reason");
});

test("recomputing the assistant snapshot clears an earlier retry error", () => {
  let outcome = latestAssistantOutcome([
    assistantMessage("error", "Stream ended without finish_reason"),
  ]);
  assert.equal(outcome.errorMessage, "Stream ended without finish_reason");

  outcome = latestAssistantOutcome([assistantMessage("stop")]);
  assert.equal(outcome.stopReason, "stop");
  assert.equal(outcome.errorMessage, undefined);
  assert.equal(agentFailure(outcome), undefined);
});

test("historical assistant errors do not override a later successful outcome", () => {
  const outcome = latestAssistantOutcome([
    assistantMessage("error", "transient provider failure"),
    assistantMessage("stop"),
  ]);

  assert.equal(outcome.stopReason, "stop");
  assert.equal(outcome.errorMessage, undefined);
  assert.equal(agentFailure(outcome), undefined);
});

test("a later genuine assistant error remains terminal", () => {
  const outcome = latestAssistantOutcome([
    assistantMessage("stop"),
    assistantMessage("error", "retry exhausted"),
  ]);

  assert.equal(outcome.stopReason, "error");
  assert.equal(agentFailure(outcome), "retry exhausted");
});

test("no assistant message produces an empty outcome", () => {
  assert.deepEqual(
    latestAssistantOutcome([{ role: "user", content: "fixture", timestamp: 1_000 }]),
    {},
  );
});

test("an operation error remains terminal after a successful assistant snapshot", () => {
  const outcome = latestAssistantOutcome([assistantMessage("stop")]);

  assert.equal(
    agentFailure(outcome, "first-response watchdog expired"),
    "first-response watchdog expired",
  );
});

function parallelToolMessages(): AgentSession["messages"] {
  return [
    { role: "user", content: "run both", timestamp: 900 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-a",
          name: "first",
          arguments: { value: 1 },
        },
        {
          type: "toolCall",
          id: "call-b",
          name: "second",
          arguments: { value: 2 },
        },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 950,
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "first",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 1_040,
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "second",
      content: [{ type: "text", text: "second result" }],
      isError: false,
      timestamp: 1_041,
    },
  ];
}

test("completed parallel tool calls pair lifecycle timings with calls and results", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    1_000,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "second",
      args: { value: 2 },
    },
    1_002,
  );
  // Parallel calls can finish in a different order than their result messages.
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "second",
      result: { content: [{ type: "text", text: "second result" }] },
      isError: false,
    },
    1_012,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "first",
      result: { content: [{ type: "text", text: "first result" }] },
      isError: false,
    },
    1_030,
  );

  const transcript = transcriptFromMessages(parallelToolMessages(), timings);
  const toolEntries = transcript.filter((entry) => entry.role === "tool");
  const resultEntries = transcript.filter((entry) => entry.role === "toolResult");

  for (const entries of [toolEntries, resultEntries]) {
    assert.deepEqual(
      entries.map(({ toolCallId, startedAt, finishedAt, durationMs }) => ({
        toolCallId,
        startedAt,
        finishedAt,
        durationMs,
      })),
      [
        {
          toolCallId: "call-a",
          startedAt: 1_000,
          finishedAt: 1_030,
          durationMs: 30,
        },
        {
          toolCallId: "call-b",
          startedAt: 1_002,
          finishedAt: 1_012,
          durationMs: 10,
        },
      ],
    );
  }
});

test("in-flight aborted tool calls retain start timing without completion", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    2_000,
  );

  const transcript = transcriptFromMessages(parallelToolMessages().slice(0, 2), timings);
  const first = transcript.find((entry) => entry.toolCallId === "call-a");

  assert.equal(first?.startedAt, 2_000);
  assert.equal(first?.finishedAt, undefined);
  assert.equal(first?.durationMs, undefined);
  assert.equal(
    transcript.some((entry) => entry.role === "toolResult"),
    false,
  );
});

test("first-response watchdog aborts a silent provider request", async () => {
  let aborted = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      aborted = true;
    },
    { timeoutMs: 10, model: "fixture-model" },
  );

  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /no assistant response event for fixture-model within 10 ms.*stalled/i,
  );
  assert.equal(aborted, true);
});

test("first assistant response disarms the watchdog without limiting the run", async () => {
  const watchdog = createFirstResponseWatchdog(
    async () => {
      throw new Error("watchdog should have been disarmed");
    },
    { timeoutMs: 10 },
  );
  watchdog.markResponse();

  const result = await watchdog.waitFor(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20)),
  );
  assert.equal(result, "done");
});

test("structured output captures valid JSON and terminates", async () => {
  let captured: unknown;
  const tool = makeStructuredOutputTool({ type: "object" }, (value) => {
    captured = value;
  });
  const params = { value: "fixture" };

  // SAFETY: The tool implementation under test does not read the extension context.
  const result = await tool.execute("fixture", params, undefined, undefined, undefined as never);

  assert.deepEqual(captured, params);
  assert.deepEqual(result.details, params);
  assert.equal(result.terminate, true);
});

test("structured output rejects non-JSON arguments without capture or termination", async () => {
  let captureCalled = false;
  const tool = makeStructuredOutputTool({ type: "object" }, () => {
    captureCalled = true;
  });

  // SAFETY: The tool implementation under test rejects params before reading extension context.
  await assert.rejects(
    tool.execute("fixture", { value: Number.NaN }, undefined, undefined, undefined as never),
    /arguments were not plain JSON data; call it again/i,
  );
  assert.equal(captureCalled, false);
});

test("workflow children guard structured, normal, and dynamically registered tools", async () => {
  const structuredResult = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };
  const structured = {
    name: "structured_output",
    label: "Structured Output",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return structuredResult;
    },
  } satisfies ToolDefinition;
  const definitions = new Map<string, ToolDefinition>([[structured.name, structured]]);
  let listener: AgentSessionEventListener | undefined;
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe(next: AgentSessionEventListener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };

  const unsubscribe = guardWorkflowChildTools(session, 10);
  assert.equal(await structured.execute(), structuredResult);

  let dynamicSignal: AbortSignal | undefined;
  const dynamic = {
    name: "dynamic_fixture",
    label: "Dynamic Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, never>, signal?: AbortSignal) {
      dynamicSignal = signal;
      return new Promise<never>(() => {});
    },
  } satisfies ToolDefinition;
  /* eslint-disable typescript/unbound-method -- captured only to verify the guard rewraps */
  const originalDynamicExecute = dynamic.execute;
  definitions.set(dynamic.name, dynamic);
  listener?.({ type: "agent_start" });
  assert.notEqual(dynamic.execute, originalDynamicExecute);
  /* eslint-enable typescript/unbound-method */

  await assert.rejects(
    dynamic.execute("fixture", {}, undefined),
    /Tool call "dynamic_fixture" timed out after 10 ms\./,
  );
  assert.equal(dynamicSignal?.aborted, true);
  unsubscribe();
});
