/**
 * Subagents — spawn background subagents on one of three backends
 * (pi, Claude Code, Codex) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 4 running at once across all backends.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_send: follow up on an existing subagent (steer a live run, or
 *   restart a settled one) instead of spawning a second child for the same task.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. All three backends are real: pi runs
 * in-process SDK sessions, claude drives the Claude Agent SDK, codex speaks
 * JSON-RPC to a scoped `codex app-server` process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { z } from "zod";
import { resolveStandaloneChildProjectTrust } from "../shared/child-session.ts";
import { registerTrackedSubagentHost } from "../shared/tracked-subagent.ts";
import { collapsedPreview, gutterLines, statusGlyph } from "../shared/ui-kit.ts";
import {
  buildAgentRoster,
  DEFAULT_AGENT_NAME,
  loadAgentDefinitions,
  resolveSpawnAgent,
} from "./src/agents.ts";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import {
  BACKEND_NAMES,
  type BackendName,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type SubagentSnapshot,
} from "./src/domain.ts";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { SubagentManager, type SubagentManagerService } from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSendResult,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { truncateHeadTail } from "./src/truncate.ts";
import { SubagentChatRow } from "./src/ui/chat-row.ts";
import { createSubagentRuntime, runTool, type SubagentRuntime } from "./src/runtime.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

interface SubagentSpawnRenderState {
  chatRow?: SubagentChatRow;
}

/** Details carried by the `subagent-result` follow-up message. */
interface SubagentResultDetails {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
}

/**
 * A restored tool row's persisted details. Only the subagent id matters for
 * reconnecting the row, and an older session file may not carry one.
 */
const spawnedSubagentSchema = z.object({ id: z.string() });

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

/**
 * The one truncation point for child output handed to the parent model. Head
 * and tail are both kept: a subagent's conclusion is at the end of its final
 * message, so a head-only cut would drop the answer.
 */
function truncatedOutput(snap: SubagentSnapshot, maxBytes = SUBAGENT_OUTPUT_MAX_BYTES): string {
  const output = snap.finalText || "(no output)";
  return truncateHeadTail(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
    sessionFilePath: snap.meta.sessionFilePath,
  }).text;
}

/**
 * Resolve a model-facing id, or throw the error every id-taking tool shares:
 * the unknown id plus the ids the model may use. `btw` sessions are invisible
 * to the model, so they read as unknown.
 */
function requireVisibleSubagent(manager: SubagentManagerService, id: string): SubagentSnapshot {
  const snap = manager.view.get(id);
  if (snap && isModelVisible(snap)) return snap;
  const known = manager.view
    .list()
    .filter(isModelVisible)
    .map((entry) => entry.id);
  throw new Error(`Unknown subagent id "${id}". Known: ${known.join(", ") || "none"}.`);
}

/**
 * Project trust for agent-definition loading. Definitions are read once when
 * the extension registers (the roster has to be in the tool description), long
 * before a session context exists, so the persisted trust decision stands in
 * for `ctx.isProjectTrusted()`. Unset or unreadable trust fails closed and
 * simply skips `.pi/agents`.
 */
function registrationProjectTrust(cwd: string) {
  try {
    return new ProjectTrustStore(getAgentDir()).get(cwd) === true;
  } catch {
    return false;
  }
}

/**
 * Test seam. Pi's loader calls the entry point with `pi` alone; the tool tests
 * pass a runtime wired to scripted backends instead of the real three.
 */
export interface SubagentExtensionOptions {
  readonly createRuntime?: () => SubagentRuntime;
}

export default function (pi: ExtensionAPI, options: SubagentExtensionOptions = {}) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerService> | undefined;
  let managerInstance: SubagentManagerService | undefined;
  let sessionContext: ExtensionContext | undefined;
  /** Bumped on shutdown so a manager resolving afterwards is not wired up. */
  let managerGeneration = 0;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const chatRows = new Set<SubagentChatRow>();
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const registrationCwd = process.cwd();
  const agentDefinitions = loadAgentDefinitions({
    agentDir: getAgentDir(),
    cwd: registrationCwd,
    projectTrusted: registrationProjectTrust(registrationCwd),
  });
  const agentRoster = buildAgentRoster(agentDefinitions.agents);

  /** The harness a spawn resolves to; tolerates an unknown agent name. */
  const spawnHarness = (agent: string | undefined, harness: BackendName | undefined): BackendName =>
    harness ?? agentDefinitions.agents.get(agent?.trim() || DEFAULT_AGENT_NAME)?.harness ?? "pi";

  const getRuntime = () => (runtime ??= (options.createRuntime ?? createSubagentRuntime)());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    const generation = managerGeneration;
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        // session_shutdown may have disposed this manager while the promise
        // was pending; subscribing to it now would resurrect the teardown.
        if (generation !== managerGeneration) return manager;
        managerInstance = manager;
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  const unregisterHost = registerTrackedSubagentHost(pi, {
    async spawn(request) {
      const manager = await getManager();
      return runTool(
        getRuntime(),
        manager.spawn(
          request.backend,
          {
            prompt: request.prompt,
            title: request.title,
            cwd: request.cwd,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            tools: request.tools,
            parent: request.parent,
          },
          { onSettled: request.onSettled },
        ),
      );
    },
    async list() {
      const manager = await getManager();
      return manager.view.list();
    },
    async cancel(ids) {
      const manager = await getManager();
      await runTool(getRuntime(), manager.cancel(ids));
    },
  });

  /** Last `running/done/failed` written to the status line, so a stream of
   * snapshot events that does not move a count is not repainted. */
  let statusCounts = "";
  const updateStatus = (manager: SubagentManagerService) => {
    if (!ui) return;
    const subs = manager.view.list();
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    const key = `${running}/${done}/${failed}`;
    if (key === statusCounts) return;
    statusCounts = key;
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, "subagents", { running, done, failed }),
    );
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
        }),
        display: true,
        details: { id: snap.id, title: snap.title, status: snap.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // Custom entries are durable TUI-only content, so side questions never
    // enter the parent model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // Shutdown may settle children while their scopes are being disposed.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
    for (const warning of agentDefinitions.warnings) {
      ui?.notify(`subagents: skipped agent definition — ${warning}`, "warning");
    }
  });

  pi.on("agent_settled", flushResults);

  pi.on("session_shutdown", async () => {
    unregisterHost();
    managerGeneration++;
    sessionContext = undefined;
    resultDelivery.clear();
    for (const row of chatRows) row.dispose();
    chatRows.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    ui = undefined;
    statusCounts = "";
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    managerInstance = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: agentRoster
      ? `${SUBAGENT_SPAWN_TOOL_DESCRIPTION}\n\n${agentRoster}`
      : SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      agent: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.agent,
        }),
      ),
      harness: Type.Optional(
        StringEnum(BACKEND_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      // Caller > agent definition > pi, for every execution option.
      const agent = resolveSpawnAgent(agentDefinitions.agents, params.agent);
      const harness = params.harness ?? agent.harness ?? "pi";

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const title = params.name.trim().slice(0, 160) || "subagent";
      const snap = await runTool(
        getRuntime(),
        manager.spawn(harness, {
          prompt: params.prompt,
          title,
          cwd,
          model: params.model ?? agent.model,
          reasoningEffort: params.reasoning_effort ?? agent.reasoningEffort,
          tools: agent.tools,
          systemPrompt: agent.prompt,
          agentName: agent.name,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: resolveStandaloneChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
        { signal, interruptMessage: "Subagent spawn aborted." },
      );

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              agent: agent.name,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          agent: agent.name,
          harness,
          model: snap.meta.modelLabel,
        },
      };
    },
    renderCall(args, theme, context) {
      const state: SubagentSpawnRenderState = context.state;
      const harness = spawnHarness(args.agent, args.harness);
      if (!state.chatRow) {
        state.chatRow = new SubagentChatRow(harness, args.name, theme, {
          // A settled subagent stops notifying its row, and the row keeps
          // rendering its final state from the snapshot it already captured.
          // Retire it here so `chatRows` stays bounded by the live rows only.
          onSubscriptionChange: (row, active) => {
            if (active) return;
            row.dispose();
            chatRows.delete(row);
          },
        });
        chatRows.add(state.chatRow);
      }
      state.chatRow.update(harness, args.name, theme);
      state.chatRow.setRequestInvalidate(context.invalidate);
      return state.chatRow;
    },
    renderResult(result, _options, theme, context) {
      const state: SubagentSpawnRenderState = context.state;
      const row = state.chatRow;
      if (row) {
        if (context.isError) {
          row.markFailed();
        } else if (!context.executionStarted) {
          // Restored tool rows have no live manager state. Keep the durable
          // record without pretending that their child is still active.
          row.markStarted();
        } else {
          const spawned = spawnedSubagentSchema.safeParse(result.details);
          const id = spawned.success ? spawned.data.id : undefined;
          if (id && managerInstance) {
            row.connect(managerInstance.view, id, context.invalidate);
          } else {
            row.markStarted();
          }
        }
      }
      // A refused spawn (bad working_dir, concurrency limit, unknown agent) is
      // the user's to fix, so the reason goes under the failed row instead of
      // into an empty slot the parent model alone can read.
      if (context.isError) {
        const reason = result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n")
          .trim();
        if (reason) {
          const body = gutterLines(theme, reason.split("\n"), "error").join("\n");
          if (context.lastComponent instanceof Text) {
            context.lastComponent.setText(body);
            return context.lastComponent;
          }
          return new Text(body, 0, 0);
        }
      }
      return context.lastComponent instanceof Container ? context.lastComponent : new Container();
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0) throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [{ type: "text", text: `Waiting for ${pending.join(", ")}...` }],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const text = truncateHeadTail(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      }).text;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0) throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids));

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
      }),
      prompt: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.prompt,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = requireVisibleSubagent(manager, params.id);
      const prompt = params.prompt.trim();
      if (!prompt) throw new Error("Provide a follow-up prompt to send.");

      const running = snap.status === "running";
      await runTool(getRuntime(), manager.send(snap.id, prompt));
      // The restarted run supersedes the settled one, so drop the deferred
      // copy of the old result instead of delivering both.
      if (!running) resultDelivery.consume([snap.id]);

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSendResult({
              id: snap.id,
              title: snap.title,
              running,
              // Unknown capability (a restored or foreign snapshot) reads as
              // steering: the harnesses that cannot steer say so explicitly.
              steering: snap.meta.steering !== false,
            }),
          },
        ],
        details: { id: snap.id, title: snap.title, running },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = requireVisibleSubagent(manager, params.id);

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHeadTail(output, {
          maxBytes: 2048,
          maxLines: 20,
          sessionFilePath: snap.meta.sessionFilePath,
        });
        text += `\n\nLatest output:\n${preview.text}`;
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0 ? "No subagents." : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer<SubagentResultDetails>(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = message.details;
      const failed = details?.status === "error";
      const icon = statusGlyph(theme, failed ? "error" : "success");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details?.id ?? "?"}`)) +
        theme.fg("muted", ` · ${details?.title ?? ""} · ${failed ? "failed" : "finished"}`);

      const content = Array.isArray(message.content) ? "" : message.content;
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [...container.render(width), ...md.render(width)],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      return new Text(collapsedPreview(theme, header, body), 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>("btw-result", (entry, { expanded }, theme) => {
    const data = entry.data;
    const failed = data?.status === "error";
    const icon = statusGlyph(theme, failed ? "error" : "success");
    const header =
      `${icon} ` +
      theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
      theme.fg("muted", ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`);
    const answer = [
      data?.errorText ? `Error: ${data.errorText}` : "",
      data?.answer ?? "(no answer)",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (expanded) {
      const body = [data?.prompt ? `**Question**\n\n${data.prompt}` : "", answer]
        .filter(Boolean)
        .join("\n\n---\n\n");
      const md = new Markdown(body, 0, 0, getMarkdownTheme());
      const container = new Text(header, 0, 0);
      return {
        render: (width: number) => [...container.render(width), ...md.render(width)],
        invalidate: () => {
          container.invalidate();
          md.invalidate();
        },
      };
    }

    return new Text(collapsedPreview(theme, header, answer), 0, 0);
  });

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: deriveBtwTitle(prompt),
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("btw", {
    description: "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    // Completions run on every keystroke, so they read the manager only if one
    // already exists rather than booting the runtime to answer.
    getArgumentCompletions: (argumentPrefix) =>
      managerInstance
        ? managerInstance.view
            .list()
            .filter((snap) => snap.id.startsWith(argumentPrefix))
            .map((snap) => ({ value: snap.id, label: `${snap.id} · ${snap.title}` }))
        : null,
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Subagent takeover is only available in the TUI", "error");
        return;
      }
      const manager = await getManager();
      // `/subagents sa-3` goes straight into that subagent; the picker is for
      // when the user does not already know which one they want.
      const id = args.trim();
      if (id) {
        if (!manager.view.get(id)) {
          ctx.ui.notify(`No subagent ${id}`, "warning");
          return;
        }
        await openSubagentTakeover(ctx, manager.view, id);
        return;
      }
      if (manager.view.size() === 0) {
        ctx.ui.notify("No subagents yet. The agent spawns them with subagent_spawn.", "info");
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
