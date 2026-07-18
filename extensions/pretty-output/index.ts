import { isAbsolute, relative, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
  keyHint,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

const originalCallComponent = Symbol("pretty-output.original-call");
const originalResultComponent = Symbol("pretty-output.original-result");
const compactCallComponent = Symbol("pretty-output.compact-call");
const compactResultComponent = Symbol("pretty-output.compact-result");
const startedAt = Symbol("pretty-output.started-at");
const endedAt = Symbol("pretty-output.ended-at");

type AnyArgs = Record<string, unknown>;
type AnyResult = {
  content: Array<TextContent | ImageContent>;
  details: Record<string, unknown> | undefined;
};
type RendererState = Record<PropertyKey, unknown>;
type AnyToolDefinition = ToolDefinition<any, any, RendererState>;
type RenderContext = Parameters<
  NonNullable<AnyToolDefinition["renderCall"]>
>[2] & { args: AnyArgs };

interface ToolPresentation {
  icon: string;
  action: string;
  target(args: AnyArgs, cwd: string): string;
  meta?(args: AnyArgs): string | undefined;
  progress?(args: AnyArgs, result: AnyResult): string;
  success(args: AnyArgs, result: AnyResult): string;
  timed?: boolean;
}

function value(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function displayPath(rawPath: unknown, cwd: string): string {
  const path = value(rawPath) || ".";
  if (!isAbsolute(path)) return path;

  const relativePath = relative(cwd, path);
  if (relativePath === "") return ".";
  if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`)) return relativePath;

  const home = process.env.HOME;
  if (home) {
    const homeRelative = relative(home, path);
    if (homeRelative === "") return "~";
    if (homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`)) {
      return `~/${homeRelative}`;
    }
  }

  return path;
}

function compact(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function textOutput(result: AnyResult): string {
  return result.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function lineCount(text: string): number {
  const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
  if (!normalized || normalized === "(no output)") return 0;
  return normalized.split("\n").length;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function contentLineCount(content: unknown): number {
  const text = value(content).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return text ? text.split("\n").length : 0;
}

function lastUsefulLine(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return compact(lines.at(-1) ?? "Tool failed", 180);
}

function duration(state: RendererState): string | undefined {
  const start = state[startedAt];
  const end = state[endedAt];
  if (typeof start !== "number") return undefined;

  const milliseconds = (typeof end === "number" ? end : Date.now()) - start;
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;

  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function withDuration(summary: string, context: RenderContext, enabled?: boolean): string {
  if (!enabled) return summary;
  const elapsed = duration(context.state);
  return elapsed ? `${summary} · ${elapsed}` : summary;
}

function reuseText(
  context: RenderContext,
  slot: symbol,
  text: string,
): Text {
  const previous = context.state[slot];
  const component = previous instanceof Text ? previous : new Text("", 0, 0);
  component.setText(text);
  context.state[slot] = component;
  return component;
}

function invokeOriginalCall(
  renderer: NonNullable<ToolDefinition<any, any, any>["renderCall"]>,
  args: AnyArgs,
  theme: Parameters<NonNullable<ToolDefinition<any, any, any>["renderCall"]>>[1],
  context: RenderContext,
): Component {
  const component = renderer(args, theme, {
    ...context,
    lastComponent: context.state[originalCallComponent] as Component | undefined,
  });
  context.state[originalCallComponent] = component;
  return component;
}

function invokeOriginalResult(
  renderer: NonNullable<ToolDefinition<any, any, any>["renderResult"]>,
  result: AnyResult,
  options: ToolRenderResultOptions,
  theme: Parameters<NonNullable<ToolDefinition<any, any, any>["renderResult"]>>[2],
  context: RenderContext,
): Component {
  const component = renderer(result, options, theme, {
    ...context,
    lastComponent: context.state[originalResultComponent] as Component | undefined,
  });
  context.state[originalResultComponent] = component;
  return component;
}

function prettify(
  definition: ToolDefinition<any, any, any>,
  presentation: ToolPresentation,
): ToolDefinition<any, any, any> {
  const originalCall = definition.renderCall;
  const originalResult = definition.renderResult;

  return {
    ...definition,
    renderShell: "self",
    renderCall(rawArgs, theme, rawContext) {
      const args = rawArgs as AnyArgs;
      const context = rawContext as RenderContext;

      if (context.executionStarted && typeof context.state[startedAt] !== "number") {
        context.state[startedAt] = Date.now();
      }
      if (!context.isPartial && typeof context.state[endedAt] !== "number") {
        context.state[endedAt] = Date.now();
      }
      if (presentation.timed) {
        context.state.startedAt ??= context.state[startedAt];
        if (!context.isPartial) context.state.endedAt ??= context.state[endedAt];
      }

      if (context.expanded && originalCall) {
        return invokeOriginalCall(originalCall, args, theme, context);
      }

      const pending = !context.executionStarted || context.isPartial;
      const color = context.isError ? "error" : pending ? "accent" : "success";
      const target = presentation.target(args, context.cwd);
      const meta = presentation.meta?.(args);
      const parts = [
        theme.fg(color, presentation.icon),
        theme.fg("toolTitle", theme.bold(presentation.action)),
        target ? theme.fg("accent", target) : "",
        meta ? theme.fg("dim", `· ${meta}`) : "",
      ].filter(Boolean);

      return reuseText(context, compactCallComponent, parts.join(" "));
    },
    renderResult(rawResult, options, theme, rawContext) {
      const result = rawResult as AnyResult;
      const context = rawContext as RenderContext;

      if (options.expanded && originalResult) {
        return invokeOriginalResult(originalResult, result, options, theme, context);
      }

      if (presentation.timed && context.state.interval) {
        clearInterval(context.state.interval as NodeJS.Timeout);
        context.state.interval = undefined;
      }

      if (options.isPartial && !context.isError) {
        const progress = presentation.progress?.(context.args, result) ?? "working";
        const summary = withDuration(progress, context, presentation.timed);
        return reuseText(
          context,
          compactResultComponent,
          `  ${theme.fg("accent", "⋯")} ${theme.fg("dim", summary)}`,
        );
      }

      context.state[endedAt] ??= Date.now();

      if (context.isError) {
        const message = lastUsefulLine(textOutput(result));
        return reuseText(
          context,
          compactResultComponent,
          `  ${theme.fg("error", "✗")} ${theme.fg("error", message)}`,
        );
      }

      const summary = withDuration(
        presentation.success(context.args, result),
        context,
        presentation.timed,
      );
      return reuseText(
        context,
        compactResultComponent,
        `  ${theme.fg("success", "✓")} ${theme.fg("muted", summary)} ${theme.fg("dim", "·")} ${keyHint("app.tools.expand", "details")}`,
      );
    },
  };
}

function outputSummary(result: AnyResult, noun: string, pluralForm = `${noun}s`): string {
  const lines = lineCount(textOutput(result));
  return lines === 0 ? "no output" : plural(lines, noun, pluralForm);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const cwd = ctx.cwd;

    pi.registerTool(
      prettify(createReadToolDefinition(cwd), {
        icon: "○",
        action: "Read",
        target: (args, toolCwd) => displayPath(args.path ?? args.file_path, toolCwd),
        meta: (args) => {
          if (typeof args.offset !== "number" && typeof args.limit !== "number") return undefined;
          const start = typeof args.offset === "number" ? args.offset : 1;
          const end = typeof args.limit === "number" ? start + args.limit - 1 : "…";
          return `lines ${start}–${end}`;
        },
        success: (_args, result) => outputSummary(result, "line"),
      }),
    );

    pi.registerTool(
      prettify(createWriteToolDefinition(cwd), {
        icon: "✎",
        action: "Write",
        target: (args, toolCwd) => displayPath(args.path ?? args.file_path, toolCwd),
        meta: (args) => {
          const content = value(args.content);
          return `${plural(contentLineCount(content), "line")} · ${formatSize(Buffer.byteLength(content))}`;
        },
        success: (args) => `${formatSize(Buffer.byteLength(value(args.content)))} written`,
      }),
    );

    pi.registerTool(
      prettify(createEditToolDefinition(cwd), {
        icon: "✎",
        action: "Edit",
        target: (args, toolCwd) => displayPath(args.path ?? args.file_path, toolCwd),
        meta: (args) => plural(Array.isArray(args.edits) ? args.edits.length : 0, "change"),
        success: (args) => plural(Array.isArray(args.edits) ? args.edits.length : 0, "change"),
      }),
    );

    pi.registerTool(
      prettify(createBashToolDefinition(cwd), {
        icon: "▶",
        action: "Run",
        target: (args) => compact(value(args.command) || "…"),
        meta: (args) => (typeof args.timeout === "number" ? `timeout ${args.timeout}s` : undefined),
        progress: (_args, result) => {
          const lines = lineCount(textOutput(result));
          return lines > 0 ? `running · ${plural(lines, "output line")}` : "running";
        },
        success: (_args, result) => {
          const summary = outputSummary(result, "output line");
          const truncation = result.details?.truncation as { truncated?: boolean } | undefined;
          return truncation?.truncated ? `${summary} · truncated` : summary;
        },
        timed: true,
      }),
    );

    pi.registerTool(
      prettify(createGrepToolDefinition(cwd), {
        icon: "⌕",
        action: "Search",
        target: (args) => compact(value(args.pattern) || "…", 80),
        meta: (args) => displayPath(args.path, cwd),
        success: (_args, result) => outputSummary(result, "result line"),
      }),
    );

    pi.registerTool(
      prettify(createFindToolDefinition(cwd), {
        icon: "◇",
        action: "Find",
        target: (args) => compact(value(args.pattern) || "…", 80),
        meta: (args) => displayPath(args.path, cwd),
        success: (_args, result) => outputSummary(result, "path"),
      }),
    );

    pi.registerTool(
      prettify(createLsToolDefinition(cwd), {
        icon: "≡",
        action: "List",
        target: (args, toolCwd) => displayPath(args.path, toolCwd),
        success: (_args, result) => outputSummary(result, "entry", "entries"),
      }),
    );

    if (ctx.mode === "tui") {
      ctx.ui.setWorkingMessage(ctx.ui.theme.fg("bashMode", "Combobulating…"));
      ctx.ui.setWorkingIndicator({
        frames: [
          ctx.ui.theme.fg("dim", "✻"),
          ctx.ui.theme.fg("muted", "✻"),
          ctx.ui.theme.fg("bashMode", "✻"),
          ctx.ui.theme.fg("warning", "✻"),
          ctx.ui.theme.fg("bashMode", "✻"),
          ctx.ui.theme.fg("muted", "✻"),
        ],
        intervalMs: 100,
      });
    }
  });
}
