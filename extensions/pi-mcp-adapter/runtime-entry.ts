import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  authenticateServer,
  logoutServer,
  openMcpAuthPanel,
  openMcpPanel,
  openMcpSetup,
  reconnectServers,
  showStatus,
  showTools,
} from "./commands.ts";
import { createCodeModeExecutor } from "./code-mode.ts";
import type { CodeModeDetails } from "./code-mode.ts";
import { createDirectToolExecutor } from "./direct-tools.ts";
import type { DirectToolResultDetails } from "./direct-tools.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";
import {
  executeAuthComplete,
  executeAuthStart,
  executeCall,
  executeConnect,
  executeDescribe,
  executeDisconnect,
  executeList,
  executeSearch,
  executeStatus,
  executeUiMessages,
} from "./proxy-modes.ts";
import type { ProxyResultDetails } from "./proxy-modes.ts";
import { initializeOAuth, shutdownOAuth } from "./mcp-auth-flow.ts";
import type { McpExtensionState } from "./state.ts";
import type {
  McpProxyParams,
  McpRuntimeSession,
} from "./runtime-loader.ts";
import type { DirectToolSpec } from "./types.ts";
import { asJsonText, type JsonObject } from "./json-value.ts";

let oauthOwnerSequence = 0;
let activeOAuthOwner = 0;

async function shutdownOwnedOAuth(owner: number): Promise<void> {
  if (activeOAuthOwner !== owner) return;
  activeOAuthOwner = 0;
  await shutdownOAuth();
}

async function shutdownState(
  currentState: McpExtensionState | null,
  reason: string,
): Promise<void> {
  if (!currentState) return;

  if (currentState.uiServer) {
    currentState.uiServer.close(reason);
    currentState.uiServer = null;
  }

  let flushError: unknown;
  try {
    flushMetadataCache(currentState);
  } catch (error) {
    flushError = error;
  }

  let cleanupError: unknown;
  try {
    await currentState.runtime?.dispose();
  } catch (error) {
    cleanupError = error;
  }

  try {
    await currentState.lifecycle.gracefulShutdown();
  } catch (error) {
    if (cleanupError) {
      console.error("MCP: lifecycle cleanup failed after Effect runtime disposal error", error);
    } else {
      cleanupError = error;
    }
  }

  if (flushError) {
    if (cleanupError) {
      console.error("MCP: resource cleanup failed after metadata flush error", cleanupError);
    }
    throw flushError;
  }
  if (cleanupError) throw cleanupError;
}

export async function initializeRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configPath: string | undefined,
  signal: AbortSignal,
): Promise<McpRuntimeSession> {
  const oauthOwner = ++oauthOwnerSequence;
  activeOAuthOwner = oauthOwner;
  await initializeOAuth().catch((error) => {
    console.error("MCP OAuth initialization failed:", error);
  });

  let state: McpExtensionState | null = null;
  try {
    state = await initializeMcp(pi, ctx, signal);
  } catch (error) {
    try {
      await shutdownState(state, "initialization_failed");
    } catch (cleanupError) {
      console.error("MCP: failed to clean partially initialized state", cleanupError);
    }
    await shutdownOwnedOAuth(oauthOwner).catch((cleanupError) => {
      console.error("MCP: failed to shut down OAuth after initialization error", cleanupError);
    });
    throw error;
  }

  const activeState = state;
  const directExecutors = new Map<DirectToolSpec, ReturnType<typeof createDirectToolExecutor>>();
  const executeCodeMode = createCodeModeExecutor(() => activeState, () => null);
  let shutdownPromise: Promise<void> | null = null;

  async function executeProxy(
    params: McpProxyParams,
    parsedArgs: JsonObject | undefined,
    signal: AbortSignal | undefined,
    getPiTools: () => ToolInfo[],
  ) {
    if (params.action === "ui-messages") return executeUiMessages(activeState);
    if (params.action === "auth-start") {
      if (!params.server) {
        return {
          content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
          details: { mode: "auth-start", error: "missing_server" },
        };
      }
      return executeAuthStart(activeState, params.server);
    }
    if (params.action === "auth-complete") {
      if (!params.server) {
        return {
          content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
          details: { mode: "auth-complete", error: "missing_server" },
        };
      }
      const input = asJsonText(parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input);
      if (input === undefined || input.trim().length === 0) {
        return {
          content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
          details: { mode: "auth-complete", error: "missing_input" },
        };
      }
      return executeAuthComplete(activeState, params.server, input);
    }
    if (params.tool) {
      return executeCall(activeState, params.tool, parsedArgs, params.server, getPiTools, signal);
    }
    if (params.connect) return executeConnect(activeState, params.connect, signal);
    if (params.disconnect) return executeDisconnect(activeState, params.disconnect);
    if (params.describe) return executeDescribe(activeState, params.describe);
    if (params.search) {
      return executeSearch(activeState, params.search, params.regex, params.server, params.includeSchemas);
    }
    if (params.server) return executeList(activeState, params.server);
    return executeStatus(activeState);
  }

  async function executeCommand(
    args: string | undefined,
    commandContext: ExtensionCommandContext,
  ): Promise<void> {
    const parts = args?.trim()?.split(/\s+/) ?? [];
    const subcommand = parts[0] ?? "";
    const targetServer = parts[1];
    const rest = parts.slice(1).join(" ");

    switch (subcommand) {
      case "reconnect":
        await reconnectServers(activeState, commandContext, targetServer);
        break;
      case "tools":
        await showTools(activeState, commandContext);
        break;
      case "disconnect": {
        if (!targetServer) {
          if (commandContext.hasUI) {
            commandContext.ui.notify("Usage: /mcp disconnect <server>", "error");
          }
          return;
        }
        const result = await executeDisconnect(activeState, targetServer);
        const text = result.content.find((item) => item.type === "text");
        if (commandContext.hasUI && text?.type === "text") {
          commandContext.ui.notify(text.text, result.details?.error ? "error" : "info");
        }
        break;
      }
      case "setup": {
        const result = await openMcpSetup(activeState, pi, commandContext, configPath, "setup");
        if (result?.configChanged) await commandContext.reload();
        break;
      }
      case "logout": {
        const serverName = rest;
        if (!serverName) {
          if (commandContext.hasUI) {
            commandContext.ui.notify("Usage: /mcp logout <server>", "error");
          }
          return;
        }
        await logoutServer(serverName, activeState, commandContext);
        break;
      }
      case "status":
      case "":
      default:
        if (commandContext.hasUI) {
          const result = await openMcpPanel(activeState, pi, commandContext, configPath);
          if (result?.configChanged) await commandContext.reload();
        } else {
          await showStatus(activeState, commandContext);
        }
        break;
    }
  }

  async function executeAuthCommand(
    args: string | undefined,
    commandContext: ExtensionCommandContext,
  ): Promise<void> {
    const serverName = args?.trim();
    if (!serverName) {
      await openMcpAuthPanel(activeState, pi, commandContext, configPath);
      return;
    }
    await authenticateServer(serverName, activeState.config, commandContext);
  }

  return {
    activate() {
      updateStatusBar(activeState);
    },
    async executeDirect(spec, toolCallId, params, signal) {
      let executor = directExecutors.get(spec);
      if (!executor) {
        executor = createDirectToolExecutor(() => activeState, () => null, spec);
        directExecutors.set(spec, executor);
      }
      return executor(toolCallId, params, signal);
    },
    executeCodeMode,
    executeProxy,
    executeCommand,
    executeAuthCommand,
    shutdown(reason) {
      shutdownPromise ??= Promise.all([
        shutdownState(activeState, reason),
        shutdownOwnedOAuth(oauthOwner),
      ]).then(() => undefined);
      return shutdownPromise;
    },
  } satisfies McpRuntimeSession;
}

export type { DirectToolResultDetails, ProxyResultDetails, CodeModeDetails, AgentToolUpdateCallback };
