import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { CodeModeDetails } from "./code-mode.ts";
import type { DirectToolResultDetails } from "./direct-tools.ts";
import type { JsonObject } from "./json-value.ts";
import type { ProxyResultDetails } from "./proxy-modes.ts";
import type { DirectToolSpec } from "./types.ts";

export interface McpProxyParams {
  tool?: string;
  args?: string;
  connect?: string;
  disconnect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

export interface McpRuntimeSession {
  activate: () => void;
  executeDirect: (
    spec: DirectToolSpec,
    toolCallId: string,
    params: JsonObject,
    signal: AbortSignal | undefined,
  ) => Promise<AgentToolResult<DirectToolResultDetails>>;
  executeCodeMode: (
    toolCallId: string,
    params: { readonly code: string },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<CodeModeDetails> | undefined,
  ) => Promise<AgentToolResult<CodeModeDetails>>;
  executeProxy: (
    params: McpProxyParams,
    parsedArgs: JsonObject | undefined,
    signal: AbortSignal | undefined,
    getPiTools: () => ToolInfo[],
  ) => Promise<AgentToolResult<ProxyResultDetails>>;
  executeCommand: (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
  executeAuthCommand: (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
}

export interface RuntimeEntryModule {
  initializeRuntime(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    configPath: string | undefined,
    signal: AbortSignal,
  ): Promise<McpRuntimeSession>;
}

export type RuntimeModuleImporter = () => Promise<RuntimeEntryModule>;

export interface RuntimeLoader {
  load(): Promise<McpRuntimeSession>;
  shutdown(reason: string): Promise<void>;
  isLoaded(): boolean;
}

let runtimeModulePromise: Promise<RuntimeEntryModule> | null = null;

function runtimeModule(): Promise<RuntimeEntryModule> {
  runtimeModulePromise ??= import("./runtime-entry.ts");
  return runtimeModulePromise;
}

export function createRuntimeLoader(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configPath: string | undefined,
  isCurrent: () => boolean,
  importRuntime: RuntimeModuleImporter = runtimeModule,
): RuntimeLoader {
  let active = true;
  const startupController = new AbortController();
  let rawInitialization: Promise<McpRuntimeSession> | null = null;
  let initialization: Promise<McpRuntimeSession> | null = null;
  let loadedSession: McpRuntimeSession | null = null;
  let disposal: Promise<void> | null = null;
  let shutdownReason = "session_shutdown";

  function dispose(session: McpRuntimeSession, reason: string): Promise<void> {
    disposal ??= session.shutdown(reason);
    return disposal;
  }

  function load(): Promise<McpRuntimeSession> {
    if (!active) {
      return Promise.reject(new Error("MCP session is no longer active"));
    }
    if (initialization) return initialization;

    rawInitialization = importRuntime().then((module) => {
      if (!active) throw new Error("MCP session is no longer active");
      return module.initializeRuntime(pi, ctx, configPath, startupController.signal);
    });
    initialization = rawInitialization.then(async (session) => {
      if (!active || !isCurrent()) {
        await dispose(session, shutdownReason);
        throw new Error("MCP session was replaced during initialization");
      }
      try {
        session.activate();
      } catch (error) {
        await dispose(session, "initialization_failed");
        throw error;
      }
      loadedSession = session;
      return session;
    });
    return initialization;
  }

  async function shutdown(reason: string): Promise<void> {
    active = false;
    shutdownReason = reason;
    startupController.abort(new Error(`MCP initialization stopped: ${reason}`));
    if (loadedSession) {
      await dispose(loadedSession, reason);
      return;
    }
    if (!rawInitialization) return;

    let session: McpRuntimeSession;
    try {
      session = await rawInitialization;
    } catch {
      return;
    }
    await dispose(session, reason);
  }

  return {
    load,
    shutdown,
    isLoaded: () => loadedSession !== null,
  };
}
