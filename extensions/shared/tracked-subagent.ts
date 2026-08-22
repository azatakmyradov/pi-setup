import { z } from "zod";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { BackendName, ReasoningEffort, SubagentSnapshot } from "../subagents/src/domain.ts";

const TRACKED_SUBAGENT_HOST_CHANNEL = "subagents:host";

export interface TrackedSubagentSpawnRequest {
  readonly backend: BackendName;
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly tools?: ReadonlyArray<string>;
  readonly parent: {
    readonly parentCwd: string;
    readonly projectTrusted: boolean;
    readonly inheritedModel?: {
      readonly provider: string;
      readonly id: string;
    };
    readonly inheritedThinkingLevel?: string;
    readonly modelRegistry?: ModelRegistry;
  };
  /** Return true to suppress the normal `subagent-result` delivery. */
  readonly onSettled?: (snapshot: SubagentSnapshot, consumed: boolean) => boolean | void;
}

export interface TrackedSubagentHost {
  spawn(request: TrackedSubagentSpawnRequest): Promise<SubagentSnapshot>;
  list(): Promise<ReadonlyArray<SubagentSnapshot>>;
  cancel(ids: ReadonlyArray<string>): Promise<void>;
}

/**
 * The event bus carries `unknown`, so the request is decoded here before the
 * host is handed over. `accept` is the requester's own callback, kept by
 * reference through the decode.
 */
const hostRequestSchema = z.object({
  accept: z.custom<(host: TrackedSubagentHost) => void>((value) => value instanceof Function),
});

type HostRequest = z.infer<typeof hostRequestSchema>;

/** Publish the current session's tracked-subagent host to other extensions. */
export function registerTrackedSubagentHost(
  pi: ExtensionAPI,
  host: TrackedSubagentHost,
): () => void {
  return pi.events.on(TRACKED_SUBAGENT_HOST_CHANNEL, (value) => {
    const request = hostRequestSchema.safeParse(value);
    if (request.success) request.data.accept(host);
  });
}

/** Discover the tracked-subagent host registered by the subagents extension. */
export function getTrackedSubagentHost(pi: ExtensionAPI): TrackedSubagentHost | undefined {
  let host: TrackedSubagentHost | undefined;
  const request: HostRequest = {
    accept(candidate) {
      host ??= candidate;
    },
  };
  pi.events.emit(TRACKED_SUBAGENT_HOST_CHANNEL, request);
  return host;
}
