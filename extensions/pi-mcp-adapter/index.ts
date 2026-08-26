import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CODE_MODE_TOOL_NAME,
  buildCodeModeMetadataFromCache,
  codeModeToolDescription,
  codeModeToolParameters,
  resolveCodeModeSettings,
} from "./code-mode-catalog.ts";
import { loadMcpConfig } from "./config.ts";
import {
  buildProxyDescription,
  getMissingConfiguredDirectToolServers,
  resolveDirectTools,
} from "./direct-tools-catalog.ts";
import { toolErrorOverride, toolResultErrorSignalSchema } from "./error-signal.ts";
import { asJsonText, type JsonObject } from "./json-value.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { parseProxyArguments } from "./proxy-input.ts";
import {
  createRuntimeLoader,
  type McpProxyParams,
  type McpRuntimeSession,
  type RuntimeLoader,
} from "./runtime-loader.ts";
import { shouldInitializeRuntimeAtSessionStart } from "./startup-policy.ts";
import {
  createMcpDirectToolCallRenderer,
  renderMcpCodeModeResult,
  renderMcpProxyToolCall,
  renderMcpToolResult,
} from "./tool-result-renderer.ts";
import type { DirectToolSpec } from "./types.ts";
import {
  getConfigPathFromArgv,
  normalizeDirectToolInputSchema,
  stringifyUnknown,
  truncateAtWord,
} from "./utils.ts";
import { throwIfAborted } from "./abort.ts";

export default function mcpAdapter(pi: ExtensionAPI) {
  let loader: RuntimeLoader | null = null;
  let lifecycleGeneration = 0;

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";
  const shouldRegisterCodeMode = resolveCodeModeSettings(
    earlyConfig.settings?.codeMode,
  ).enabled;
  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = shouldRegisterCodeMode || envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map((value) => value.trim()).filter(Boolean),
      );
  const missingConfiguredDirectToolServers = shouldRegisterCodeMode
    ? []
    : getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const shouldRegisterProxyTool = !shouldRegisterCodeMode && (
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0
  );

  async function loadRuntimeForDirectTool(spec: DirectToolSpec, toolCallId: string, params: JsonObject, signal: AbortSignal | undefined) {
    throwIfAborted(signal);
    const currentLoader = loader;
    if (!currentLoader) {
      return {
        content: [{ type: "text" as const, text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      };
    }

    try {
      const runtime = await currentLoader.load();
      return runtime.executeDirect(spec, toolCallId, params, signal);
    } catch (error) {
      const message = stringifyUnknown(error);
      return {
        content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
        details: { error: "init_failed", message },
      };
    }
  }

  for (const spec of directSpecs) {
    // SAFETY: the adapter's renderers are declared over its own MCP result and
    // render-context types, which pi's generic ToolDefinition parameters cannot
    // express; every field pi itself reads matches ToolDefinition exactly.
    pi.registerTool({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe(normalizeDirectToolInputSchema(spec.inputSchema)),
      renderShell: "self",
      execute: (
        toolCallId: string,
        params: JsonObject,
        signal: AbortSignal | undefined,
      ) => loadRuntimeForDirectTool(spec, toolCallId, params, signal),
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
      renderResult: renderMcpToolResult,
    } as ToolDefinition);
  }

  if (shouldRegisterCodeMode) {
    const earlyCodeModeMetadata = buildCodeModeMetadataFromCache(earlyConfig, earlyCache);
    // SAFETY: same renderer/result-detail variance as the direct tools above —
    // pi only reads the fields this object provides in ToolDefinition form.
    pi.registerTool({
      name: CODE_MODE_TOOL_NAME,
      label: "MCP Execute",
      description: codeModeToolDescription(earlyConfig, earlyCodeModeMetadata),
      promptSnippet: "Run a confined MCP code-mode program over cached MCP tools",
      renderShell: "self",
      parameters: codeModeToolParameters(),
      renderResult: renderMcpCodeModeResult,
      async execute(
        toolCallId: string,
        params: { readonly code: string },
        signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ) {
        const currentLoader = loader;
        if (!currentLoader) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: {
              mode: "code" as const,
              childCalls: [],
              toolCalls: [],
              error: "not_initialized" as const,
            },
          };
        }

        const runtime = await currentLoader.load();
        return runtime.executeCodeMode(toolCallId, params, signal, onUpdate);
      },
    } as ToolDefinition);
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousLoader = loader;
    loader = null;

    if (previousLoader) {
      const shutdown = previousLoader.shutdown("session_restart");
      if (previousLoader.isLoaded()) {
        try {
          await shutdown;
        } catch (error) {
          console.error("MCP: failed to shut down previous session state", error);
        }
      } else {
        void shutdown.catch((error) => {
          console.error("MCP: failed to shut down previous session state", error);
        });
      }
    }

    if (generation !== lifecycleGeneration) return;

    const configPath = asJsonText(pi.getFlag("mcp-config")) ?? earlyConfigPath;
    const sessionConfig = loadMcpConfig(configPath, ctx.cwd);
    const sessionCache = loadMetadataCache();
    let nextLoader: RuntimeLoader;
    nextLoader = createRuntimeLoader(
      pi,
      ctx,
      configPath,
      () => generation === lifecycleGeneration && loader === nextLoader,
    );
    loader = nextLoader;

    if (shouldInitializeRuntimeAtSessionStart(sessionConfig, sessionCache, ctx.cwd)) {
      void nextLoader.load().catch((error) => {
        if (generation === lifecycleGeneration && loader === nextLoader) {
          console.error("MCP initialization failed:", error);
        }
      });
    } else if (ctx.hasUI) {
      const serverCount = Object.keys(sessionConfig.mcpServers).length;
      ctx.ui.setStatus?.(
        "mcp",
        serverCount === 0
          ? undefined
          : ctx.ui.theme.fg("accent", `MCP: 0/${serverCount} servers`),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentLoader = loader;
    loader = null;
    if (!currentLoader) return;

    try {
      await currentLoader.shutdown("session_shutdown");
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  pi.on("tool_result", (event) => {
    const details = toolResultErrorSignalSchema.safeParse(event.details);
    return details.success ? toolErrorOverride(details.data) : undefined;
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      const currentLoader = loader;
      if (!currentLoader) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }
      let runtime: McpRuntimeSession;
      try {
        runtime = await currentLoader.load();
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP initialization failed: ${stringifyUnknown(error)}`, "error");
        }
        return;
      }
      await runtime.executeCommand(args, ctx);
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) return;

      const currentLoader = loader;
      if (!currentLoader) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }
      let runtime: McpRuntimeSession;
      try {
        runtime = await currentLoader.load();
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP initialization failed: ${stringifyUnknown(error)}`, "error");
        }
        return;
      }
      await runtime.executeAuthCommand(args, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    // SAFETY: same renderer/result-detail variance as the direct tools above —
    // pi only reads the fields this object provides in ToolDefinition form.
    pi.registerTool({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      renderShell: "self",
      renderCall: renderMcpProxyToolCall,
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect and remember for this project" })),
        disconnect: Type.Optional(Type.String({ description: "Server name to disconnect and stop remembering for this project" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(
        _toolCallId: string,
        params: McpProxyParams,
        signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx: ExtensionContext,
      ) {
        const parsedArgs = parseProxyArguments(params.args);
        const currentLoader = loader;
        if (!currentLoader) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          };
        }
        try {
          const runtime = await currentLoader.load();
          return runtime.executeProxy(params, parsedArgs, signal, getPiTools);
        } catch (error) {
          const message = stringifyUnknown(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
            details: { error: "init_failed", message },
          };
        }
      },
    } as ToolDefinition);
  }
}
