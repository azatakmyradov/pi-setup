import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export const MAX_FINAL_BYTES = 50 * 1024;
/** Maximum UTF-8 size of the complete JSON-serialized details object. */
export const MAX_DETAIL_BYTES = 16 * 1024;
export const MAX_PARTIAL_BYTES = 12 * 1024;
export const MAX_ACTIVITIES = 40;
export const MAX_UNKNOWN_EVENTS = 20;

const MAX_DETAIL_OUTPUT_BYTES = 10 * 1024;
const MAX_EVENT_BYTES = 512;
const MAX_EVENT_ID_BYTES = 256;

export interface ClaudeUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	turns: number;
	durationMs: number;
}

export interface ClaudeAgentDetails {
	status: "running" | "succeeded" | "incomplete";
	sessionId?: string;
	output: string;
	activities: string[];
	unknownEvents: string[];
	usage?: ClaudeUsage;
	stopReason?: string;
	truncated: boolean;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

export function truncateUtf8(value: string, maxBytes: number, label = "Output"): { text: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
	const notice = `\n\n[${label} truncated to ${maxBytes} bytes]`;
	const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
	let bytes = 0;
	let text = "";
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > budget) break;
		text += character;
		bytes += size;
	}
	return { text: text + notice, truncated: true };
}

function shortJson(value: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "";
	} catch {
		serialized = "[unserializable input]";
	}
	return truncateUtf8(serialized, 240, "Input").text.replace(/\s+/g, " ");
}

function serializedBytes(value: ClaudeAgentDetails): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fitDetailString(
	value: string,
	label: string,
	accept: (candidate: string) => boolean,
): { text: string; truncated: boolean } {
	if (accept(value)) return { text: value, truncated: false };

	const characters = Array.from(value);
	const notice = `\n\n[${label} truncated to fit details limit]`;
	let low = 0;
	let high = characters.length;
	let best = accept(notice) ? notice : "";
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = characters.slice(0, middle).join("") + notice;
		if (accept(candidate)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return { text: best, truncated: true };
}

function assistantBlocks(message: unknown): unknown[] {
	const wrapper = record(message);
	const inner = record(wrapper?.message);
	return Array.isArray(inner?.content) ? inner.content : [];
}

export class ClaudeEventParser {
	private partialText = "";
	private assistantText = "";
	private readonly activityIndexes = new Map<string, number>();
	private readonly activities: string[] = [];
	private readonly unknownEvents: string[] = [];
	private result?: SDKResultMessage;
	private sessionId?: string;
	private readonly authoritativeSessionId?: string;
	private wasTruncated = false;

	constructor(sessionId?: string) {
		this.authoritativeSessionId = sessionId;
		this.sessionId = sessionId;
	}

	ingest(message: SDKMessage): void {
		const event = message as SDKMessage & UnknownRecord;
		if (!this.authoritativeSessionId && typeof event.session_id === "string") {
			const bounded = truncateUtf8(event.session_id, MAX_EVENT_ID_BYTES, "Session id");
			this.sessionId = bounded.text;
			this.wasTruncated ||= bounded.truncated;
		}
		if (event.type === "stream_event") {
			const stream = record(event.event);
			if (stream?.type === "content_block_delta") {
				const delta = record(stream.delta);
				if (delta?.type === "text_delta" && typeof delta.text === "string") this.appendPartial(delta.text);
			} else if (stream?.type === "content_block_start") {
				const block = record(stream.content_block);
				if (block?.type === "tool_use") this.addTool(block);
			} else if (
				typeof stream?.type === "string" &&
				!["message_start", "message_delta", "message_stop", "content_block_stop", "ping"].includes(stream.type)
			) {
				this.addBounded(this.unknownEvents, `stream_event:${stream.type}`, MAX_UNKNOWN_EVENTS);
			}
			return;
		}

		if (event.type === "assistant") {
			const texts: string[] = [];
			for (const value of assistantBlocks(event)) {
				const block = record(value);
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
				if (block?.type === "tool_use") this.addTool(block);
			}
			if (texts.length > 0) this.assistantText = texts.join("\n\n");
			return;
		}

		if (event.type === "tool_progress") {
			const name = typeof event.tool_name === "string" ? event.tool_name : "tool";
			const id = typeof event.tool_use_id === "string" ? event.tool_use_id : `${name}:${this.activities.length}`;
			this.addActivity(`progress:${id}`, `${name} (${Number(event.elapsed_time_seconds ?? 0).toFixed(1)}s)`);
			return;
		}

		if (event.type === "result") {
			this.result = event as SDKResultMessage;
			return;
		}

		const subtype = typeof event.subtype === "string" ? `:${event.subtype}` : "";
		this.addBounded(this.unknownEvents, `${String(event.type ?? "unknown")}${subtype}`, MAX_UNKNOWN_EVENTS);
	}

	private appendPartial(text: string): void {
		const bounded = truncateUtf8(this.partialText + text, MAX_PARTIAL_BYTES, "Partial text");
		this.partialText = bounded.text;
		this.wasTruncated ||= bounded.truncated;
	}

	private addTool(block: UnknownRecord): void {
		const name = typeof block.name === "string" ? block.name : "tool";
		const id = typeof block.id === "string" ? block.id : `${name}:${this.activities.length}`;
		const inputRecord = record(block.input);
		const hasInput = block.input !== undefined && (!inputRecord || Object.keys(inputRecord).length > 0);
		const input = hasInput ? ` ${shortJson(block.input)}` : "";
		this.addActivity(`tool:${id}`, `→ ${name}${input}`);
	}

	private addActivity(id: string, text: string): void {
		const boundedId = truncateUtf8(id, MAX_EVENT_ID_BYTES, "Event id");
		const boundedText = truncateUtf8(text, MAX_EVENT_BYTES, "Event");
		this.wasTruncated ||= boundedId.truncated || boundedText.truncated;

		const existingIndex = this.activityIndexes.get(boundedId.text);
		if (existingIndex !== undefined) {
			// Streaming tool_use blocks begin with input: {}. The later assistant
			// message carries the complete input, so replace the placeholder.
			this.activities[existingIndex] = boundedText.text;
			return;
		}
		if (this.activities.length >= MAX_ACTIVITIES) {
			this.wasTruncated = true;
			return;
		}
		this.activityIndexes.set(boundedId.text, this.activities.length);
		this.activities.push(boundedText.text);
	}

	private addBounded(target: string[], value: string, limit: number): void {
		if (target.length >= limit) {
			this.wasTruncated = true;
			return;
		}
		const bounded = truncateUtf8(value, MAX_EVENT_BYTES, "Event");
		target.push(bounded.text);
		this.wasTruncated ||= bounded.truncated;
	}

	private buildDetails(
		status: ClaudeAgentDetails["status"],
		source: string,
		usage?: ClaudeUsage,
		stopReason?: string,
	): ClaudeAgentDetails {
		const output = truncateUtf8(source, MAX_DETAIL_OUTPUT_BYTES, "Detail output");
		const details: ClaudeAgentDetails = {
			status,
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			output: "",
			activities: [],
			unknownEvents: [],
			...(usage ? { usage } : {}),
			...(stopReason ? { stopReason } : {}),
			truncated: this.wasTruncated || output.truncated,
		};

		const fittedOutput = fitDetailString(output.text, "Detail output", (candidate) =>
			serializedBytes({ ...details, output: candidate, truncated: false }) <= MAX_DETAIL_BYTES,
		);
		details.output = fittedOutput.text;
		details.truncated ||= fittedOutput.truncated;

		for (const activity of this.activities) {
			const candidate = { ...details, activities: [...details.activities, activity] };
			if (serializedBytes(candidate) > MAX_DETAIL_BYTES) {
				details.truncated = true;
				break;
			}
			details.activities.push(activity);
		}
		for (const event of this.unknownEvents) {
			const candidate = { ...details, unknownEvents: [...details.unknownEvents, event] };
			if (serializedBytes(candidate) > MAX_DETAIL_BYTES) {
				details.truncated = true;
				break;
			}
			details.unknownEvents.push(event);
		}
		return details;
	}

	private usage(): ClaudeUsage | undefined {
		if (!this.result) return undefined;
		const usageRecord = this.result.usage as unknown as UnknownRecord;
		const number = (key: string): number => (typeof usageRecord[key] === "number" ? usageRecord[key] : 0);
		return {
			inputTokens: number("input_tokens"),
			outputTokens: number("output_tokens"),
			cacheReadTokens: number("cache_read_input_tokens"),
			cacheCreationTokens: number("cache_creation_input_tokens"),
			costUsd: this.result.total_cost_usd,
			turns: this.result.num_turns,
			durationMs: this.result.duration_ms,
		};
	}

	private complete(status: "succeeded" | "incomplete", source: string, stopReason?: string) {
		const prefix = stopReason ? `Claude agent stopped before completing the task: ${stopReason}\n\n` : "";
		const continuation = this.sessionId
			? `\n\n[Claude session: ${this.sessionId} — pass this as resumeSessionId to continue]`
			: "";
		const outputBudget = Math.max(
			0,
			MAX_FINAL_BYTES - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(continuation, "utf8"),
		);
		const finalBody = truncateUtf8(source, outputBudget, "Output");
		this.wasTruncated ||= finalBody.truncated;
		return {
			output: prefix + finalBody.text + continuation,
			details: this.buildDetails(status, source, this.usage(), stopReason),
		};
	}

	progressDetails(): ClaudeAgentDetails {
		return this.buildDetails("running", this.partialText || this.assistantText);
	}

	recoverMaxTurns(reason: string): { output: string; details: ClaudeAgentDetails } {
		const boundedReason = truncateUtf8(reason, MAX_EVENT_BYTES, "Stop reason");
		this.wasTruncated ||= boundedReason.truncated;
		const source = this.assistantText || this.partialText || "(no final output was produced before the turn limit)";
		return this.complete("incomplete", source, boundedReason.text);
	}

	finish(): { output: string; details: ClaudeAgentDetails } {
		if (!this.result) throw new Error("Claude Agent SDK ended without a result event");
		if (this.result.subtype === "error_max_turns") {
			const reason = this.result.errors.join("; ") || "maximum number of turns reached";
			return this.recoverMaxTurns(reason);
		}
		if (this.result.subtype !== "success" || this.result.is_error) {
			const errors = "errors" in this.result ? this.result.errors.join("; ") : "";
			throw new Error(errors || `Claude agent failed: ${this.result.subtype}`);
		}

		const source = this.result.result || this.assistantText || this.partialText || "(no output)";
		return this.complete("succeeded", source);
	}
}
