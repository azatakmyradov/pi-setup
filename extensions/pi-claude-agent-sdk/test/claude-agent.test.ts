import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createClaudeAgentExtension } from "../index.ts";
import {
	ClaudeEventParser,
	MAX_ACTIVITIES,
	MAX_DETAIL_BYTES,
	MAX_FINAL_BYTES,
	MAX_UNKNOWN_EVENTS,
} from "../parser.ts";
import { ClaudeAgentAbortError, ClaudeAgentRunner, type QueryFactory, type QueryLike } from "../runner.ts";

function sdk(value: unknown): SDKMessage {
	return value as SDKMessage;
}

function result(output = "done", overrides: Record<string, unknown> = {}): SDKMessage {
	return sdk({
		type: "result",
		subtype: "success",
		is_error: false,
		result: output,
		duration_ms: 1250,
		duration_api_ms: 1000,
		num_turns: 2,
		stop_reason: null,
		total_cost_usd: 0.0123,
		usage: {
			input_tokens: 10,
			output_tokens: 20,
			cache_read_input_tokens: 3,
			cache_creation_input_tokens: 4,
		},
		modelUsage: {},
		permission_denials: [],
		uuid: "result-id",
		session_id: "session-id",
		...overrides,
	});
}

function iterable(messages: SDKMessage[], onClose?: () => void): QueryLike {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) yield message;
		},
		close: onClose,
	};
}

test("parser handles partial text, tool activity, result usage, and unknown events", () => {
	const parser = new ClaudeEventParser();
	parser.ingest(sdk({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "working" } } }));
	parser.ingest(sdk({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } } } }));
	parser.ingest(sdk({ type: "future_event", subtype: "new_shape" }));
	parser.ingest(result("finished"));

	assert.equal(parser.progressDetails().output, "working");
	const finished = parser.finish();
	assert.match(finished.output, /^finished/);
	assert.match(finished.output, /Claude session: session-id.*resumeSessionId/);
	assert.equal(finished.details.sessionId, "session-id");
	assert.match(finished.details.activities[0] ?? "", /Read.*a\.ts/);
	assert.deepEqual(finished.details.unknownEvents, ["future_event:new_shape"]);
	assert.deepEqual(finished.details.usage, {
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 3,
		cacheCreationTokens: 4,
		costUsd: 0.0123,
		turns: 2,
		durationMs: 1250,
	});
});

test("parser replaces streamed empty tool input with the completed assistant input", () => {
	const parser = new ClaudeEventParser();
	parser.ingest(sdk({
		type: "stream_event",
		event: {
			type: "content_block_start",
			content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} },
		},
	}));
	assert.deepEqual(parser.progressDetails().activities, ["→ Bash"]);

	parser.ingest(sdk({
		type: "assistant",
		message: {
			content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }],
		},
	}));

	assert.deepEqual(parser.progressDetails().activities, ['→ Bash {"command":"npm test"}']);
});

test("runner succeeds with a fresh query and the required SDK options", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	const calls: Parameters<QueryFactory>[0][] = [];
	let closes = 0;
	const factory: QueryFactory = (parameters) => {
		calls.push(parameters);
		return iterable([result("ok")], () => closes++);
	};
	const runner = new ClaudeAgentRunner(factory);

	const first = await runner.run({ task: "edit it", model: "claude-test", systemPrompt: "Be concise", maxTurns: 4 }, cwd);
	const second = await runner.run({ task: "check it" }, cwd);
	const resumed = await runner.run({ task: "continue it", resumeSessionId: " session-id " }, cwd);

	assert.match(first.content[0]?.text ?? "", /^ok/);
	assert.equal(first.details.sessionId, calls[0]?.options?.sessionId);
	assert.match(first.details.sessionId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(calls.length, 3, "each invocation must construct a query");
	assert.notEqual(calls[0], calls[1]);
	assert.notEqual(calls[0]?.options?.sessionId, calls[1]?.options?.sessionId);
	assert.equal(calls[0]?.options?.cwd, cwd);
	assert.equal(calls[0]?.options?.permissionMode, "bypassPermissions");
	assert.equal(calls[0]?.options?.allowDangerouslySkipPermissions, true);
	assert.equal(calls[0]?.options?.includePartialMessages, true);
	assert.equal(calls[0]?.options?.persistSession, true);
	assert.equal(calls[0]?.options?.resume, undefined);
	assert.equal(calls[0]?.options?.model, "claude-test");
	assert.equal(calls[0]?.options?.maxTurns, 4);
	assert.deepEqual(calls[0]?.options?.systemPrompt, { type: "preset", preset: "claude_code", append: "Be concise" });
	assert.equal(calls[2]?.options?.resume, "session-id");
	assert.equal(calls[2]?.options?.sessionId, undefined);
	assert.match(resumed.content[0]?.text ?? "", /Claude session: session-id/);
	assert.equal(closes, 3);
});

test("runner validates resume session ids", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	const factory: QueryFactory = () => iterable([result()]);
	const runner = new ClaudeAgentRunner(factory);
	await assert.rejects(
		runner.run({ task: "work", resumeSessionId: "   " }, cwd),
		/resumeSessionId must not be empty/,
	);
	await assert.rejects(
		runner.run({ task: "work", resumeSessionId: "x".repeat(257) }, cwd),
		/resumeSessionId exceeds 256 characters/,
	);
});

test("runner validates cwd before constructing a query", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	let calls = 0;
	const factory: QueryFactory = () => {
		calls++;
		return iterable([result()]);
	};
	await assert.rejects(
		new ClaudeAgentRunner(factory).run({ task: "work", cwd: "missing-directory" }, cwd),
		/does not exist or is inaccessible/,
	);
	assert.equal(calls, 0);
});

test("runner rejects non-recoverable SDK failure results", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	const factory: QueryFactory = () => iterable([
		result("", { subtype: "error_during_execution", is_error: true, errors: ["execution failed"] }),
	]);
	await assert.rejects(new ClaudeAgentRunner(factory).run({ task: "fail" }, cwd), /execution failed/);
});

test("runner returns a resumable incomplete result when the SDK yields a max-turns result", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	let sessionId: string | undefined;
	const factory: QueryFactory = (parameters) => {
		sessionId = parameters.options?.sessionId;
		return iterable([
			sdk({ type: "assistant", session_id: "wrong-sdk-session", message: { content: [{ type: "text", text: "findings so far" }] } }),
			result("", { subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (10)"] }),
		]);
	};

	const resultValue = await new ClaudeAgentRunner(factory).run({ task: "loop", maxTurns: 10 }, cwd);
	assert.equal(resultValue.details.status, "incomplete");
	assert.equal(resultValue.details.sessionId, sessionId);
	assert.notEqual(resultValue.details.sessionId, "wrong-sdk-session");
	assert.match(resultValue.content[0]?.text ?? "", /stopped before completing.*maximum number of turns/is);
	assert.match(resultValue.content[0]?.text ?? "", new RegExp(`Claude session: ${sessionId}`));
});

test("runner recovers max-turns errors thrown by the SDK with its authoritative session ID", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	let sessionId: string | undefined;
	const factory: QueryFactory = (parameters) => {
		sessionId = parameters.options?.sessionId;
		return {
			async *[Symbol.asyncIterator]() {
				yield sdk({ type: "assistant", session_id: "transient-session", message: { content: [{ type: "text", text: "partial review" }] } });
				throw new Error("Claude Code returned an error result: Reached maximum number of turns (10)");
			},
		};
	};

	const resultValue = await new ClaudeAgentRunner(factory).run({ task: "loop", maxTurns: 10 }, cwd);
	assert.equal(resultValue.details.status, "incomplete");
	assert.equal(resultValue.details.sessionId, sessionId);
	assert.equal(resultValue.details.output, "partial review");
	assert.equal(resultValue.details.stopReason, "Reached maximum number of turns (10)");
});

test("Pi abort is wired to the SDK controller and closes the query", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	let sdkSignal: AbortSignal | undefined;
	let closes = 0;
	const factory: QueryFactory = (parameters) => {
		sdkSignal = parameters.options?.abortController?.signal;
		return {
			async *[Symbol.asyncIterator]() {
				await new Promise<void>((resolve) => sdkSignal?.addEventListener("abort", () => resolve(), { once: true }));
			},
			close: () => closes++,
		};
	};
	const controller = new AbortController();
	const promise = new ClaudeAgentRunner(factory).run({ task: "wait" }, cwd, controller.signal);
	while (!sdkSignal) await new Promise((resolve) => setImmediate(resolve));
	controller.abort();

	await assert.rejects(promise, ClaudeAgentAbortError);
	assert.equal(sdkSignal.aborted, true);
	assert.ok(closes >= 1);
});

test("session shutdown interrupts and cleans up an active extension query", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	let sdkSignal: AbortSignal | undefined;
	let closes = 0;
	let tool: { execute: (...args: any[]) => Promise<unknown> } | undefined;
	let shutdown: (() => void) | undefined;
	const factory: QueryFactory = (parameters) => {
		sdkSignal = parameters.options?.abortController?.signal;
		return {
			async *[Symbol.asyncIterator]() {
				await new Promise<void>((resolve) => sdkSignal?.addEventListener("abort", () => resolve(), { once: true }));
			},
			close: () => closes++,
		};
	};
	const fakePi = {
		on: (event: string, handler: () => void) => {
			if (event === "session_shutdown") shutdown = handler;
		},
		registerTool: (definition: typeof tool) => {
			tool = definition;
		},
	};
	createClaudeAgentExtension(factory)(fakePi as unknown as ExtensionAPI);
	assert.ok(tool);
	assert.ok(shutdown);
	const promise = tool.execute("id", { task: "wait" }, undefined, undefined, { cwd });
	while (!sdkSignal) await new Promise((resolve) => setImmediate(resolve));
	shutdown();

	await assert.rejects(promise, ClaudeAgentAbortError);
	assert.equal(sdkSignal.aborted, true);
	assert.ok(closes >= 1);
});

test("extension exposes one Claude call only when the user message mentions Claude", () => {
	const handlers = new Map<string, Array<(event: any) => any>>();
	let activeTools = ["read", "claude"];
	const fakePi = {
		on: (event: string, handler: (event: any) => any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
	};
	createClaudeAgentExtension(() => iterable([result()]))(fakePi as unknown as ExtensionAPI);
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.map((handler) => handler(payload));

	emit("session_start");
	assert.deepEqual(activeTools, ["read"]);

	emit("input", { source: "interactive", text: "Handle this directly" });
	assert.deepEqual(activeTools, ["read"]);
	assert.match(emit("tool_call", { toolName: "claude" })?.[0]?.reason ?? "", /requires 'claude'/);

	emit("input", { source: "interactive", text: "Ask CLAUDE to review this" });
	assert.deepEqual(activeTools, ["read", "claude"]);
	assert.equal(emit("tool_call", { toolName: "claude" })?.[0], undefined);
	assert.match(emit("tool_call", { toolName: "claude" })?.[0]?.reason ?? "", /requires 'claude'/);

	emit("tool_result", { toolName: "claude" });
	assert.deepEqual(activeTools, ["read"]);

	emit("input", { source: "interactive", text: "claudel is a different word" });
	assert.deepEqual(activeTools, ["read"]);
	emit("agent_settled");
	assert.deepEqual(activeTools, ["read"]);
});

test("runner rejects concurrent invocations", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-claude-agent-"));
	let release!: () => void;
	let started = false;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const factory: QueryFactory = () => ({
		async *[Symbol.asyncIterator]() {
			started = true;
			await gate;
			yield result("first");
		},
	});
	const runner = new ClaudeAgentRunner(factory);
	const first = runner.run({ task: "first" }, cwd);
	while (!started) await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(runner.run({ task: "second" }, cwd), /already running.*serialized/);
	release();
	await first;
});

test("parser bounds final output, aggregate details, activities, and unknown events", () => {
	const parser = new ClaudeEventParser();
	for (let index = 0; index < MAX_ACTIVITIES + 10; index++) {
		parser.ingest(sdk({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${index}`, name: "Read", input: { path: `file-${index}` } }] } }));
	}
	for (let index = 0; index < MAX_UNKNOWN_EVENTS + 10; index++) parser.ingest(sdk({ type: `future-${index}` }));
	parser.ingest(result("😀".repeat(MAX_FINAL_BYTES)));
	const finished = parser.finish();

	assert.ok(Buffer.byteLength(finished.output, "utf8") <= MAX_FINAL_BYTES);
	assert.ok(Buffer.byteLength(JSON.stringify(finished.details), "utf8") <= MAX_DETAIL_BYTES);
	assert.equal(finished.details.activities.length, MAX_ACTIVITIES);
	assert.equal(finished.details.unknownEvents.length, MAX_UNKNOWN_EVENTS);
	assert.equal(finished.details.truncated, true);
	assert.match(finished.output, /truncated/);
});

test("parser byte-bounds details containing adversarial event strings", () => {
	const parser = new ClaudeEventParser();
	parser.ingest(sdk({
		type: "assistant",
		message: { content: [{ type: "tool_use", id: "id", name: "x".repeat(1_000_000) }] },
	}));
	parser.ingest(sdk({ type: `future-${"y".repeat(1_000_000)}` }));
	parser.ingest(result("\"\\\n".repeat(20_000)));

	const details = parser.finish().details;
	assert.ok(Buffer.byteLength(JSON.stringify(details), "utf8") <= MAX_DETAIL_BYTES);
	assert.equal(details.truncated, true);
});

test("parser byte-bounds adversarial max-turn stop reasons", () => {
	const parser = new ClaudeEventParser("authoritative-session");
	parser.ingest(result("", {
		subtype: "error_max_turns",
		is_error: true,
		errors: ["x".repeat(1_000_000)],
	}));

	const finished = parser.finish();
	assert.ok(Buffer.byteLength(finished.output, "utf8") <= MAX_FINAL_BYTES);
	assert.ok(Buffer.byteLength(JSON.stringify(finished.details), "utf8") <= MAX_DETAIL_BYTES);
	assert.equal(finished.details.status, "incomplete");
	assert.equal(finished.details.truncated, true);
});
