import { keyHint, type AgentToolResult, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
  fg: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface McpProxyToolCallInput {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

interface McpToolRenderContext {
  expanded?: boolean;
  isError: boolean;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatJsonish(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    try {
      return truncateText(JSON.stringify(JSON.parse(value), null, 2), maxChars);
    } catch {
      return truncateText(value, maxChars);
    }
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function hasUsefulObjectContent(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function formatMcpProxyToolCallLines(
  args: McpProxyToolCallInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (args.action === "ui-messages") return [`mcp ${args.action}`];

  if (args.tool) {
    const target = args.server ? `${args.tool} @ ${args.server}` : args.tool;
    const lines = [`mcp call ${target}`];
    if (args.args) lines.push(formatJsonish(args.args, maxInputChars));
    return lines;
  }

  if (args.connect) return [`mcp connect ${args.connect}`];
  if (args.describe) return [`mcp describe ${args.describe}`];

  if (args.search) {
    let line = `mcp search ${args.search}`;
    if (args.server) line += ` @ ${args.server}`;
    if (args.regex === true) line += " (regex)";
    if (args.includeSchemas === false) line += " (schemas hidden)";
    return [line];
  }

  if (args.server) return [`mcp list ${args.server}`];
  if (args.action) return [`mcp ${args.action}`];

  return ["mcp status"];
}

export function formatMcpDirectToolCallLines(
  displayName: string,
  args: Record<string, unknown>,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (!hasUsefulObjectContent(args)) return [displayName];
  return [displayName, formatJsonish(args, maxInputChars)];
}

function formatToolTitle(rawTitle: string): string {
  if (/^x3_(?:x3_)?/.test(rawTitle)) {
    const words = rawTitle
      .replace(/^x3_(?:x3_)?/, "")
      .split("_")
      .filter(Boolean)
      .map(word => {
        if (word === "soap") return "SOAP";
        if (word === "src") return "source";
        return word.charAt(0).toUpperCase() + word.slice(1);
      });
    return `X3 ${words.join(" ")}`;
  }
  return rawTitle.replace(/^mcp\b/, "MCP");
}

function renderToolCallLines(lines: string[], theme: RenderTheme, expanded = false) {
  const [rawTitle = "mcp", ...rest] = lines;
  const title = formatToolTitle(rawTitle);
  const styledTitle = `${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold ? theme.bold(title) : title)}`;
  if (rest.length === 0) return new Text(styledTitle, 0, 0);

  if (expanded) {
    return new Text([styledTitle, ...rest.map(line => theme.fg("muted", line))].join("\n"), 0, 0);
  }

  const summary = truncateText(rest.join(" ").replace(/\s+/g, " "), 120);
  return new Text(`${styledTitle} ${theme.fg("dim", `· ${summary}`)}`, 0, 0);
}

export function renderMcpProxyToolCall(
  args: McpProxyToolCallInput,
  theme: RenderTheme,
  context?: McpToolRenderContext,
) {
  return renderToolCallLines(formatMcpProxyToolCallLines(args), theme, context?.expanded);
}

export function createMcpDirectToolCallRenderer(displayName: string) {
  return (args: Record<string, unknown>, theme: RenderTheme, context?: McpToolRenderContext) => {
    return renderToolCallLines(formatMcpDirectToolCallLines(displayName, args), theme, context?.expanded);
  };
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = 3,
): McpToolResultDisplay {
  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];

  if (expanded || lines.length <= maxCollapsedLines) {
    return { lines, truncated: false };
  }

  return {
    lines: [...lines.slice(0, maxCollapsedLines), "…"],
    truncated: true,
  };
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context?: McpToolRenderContext,
) {
  if (options.isPartial) {
    return new Text(`  ${theme.fg("accent", "⋯")} ${theme.fg("dim", "running")}`, 0, 0);
  }

  const hasErrorDetails = Boolean(result.details?.error);
  const isError = context?.isError === true || hasErrorDetails;
  const display = formatMcpToolResultLines(result, true);

  if (isError) {
    const message = options.expanded
      ? display.lines.join("\n")
      : truncateText(display.lines.find(line => line.trim()) ?? "MCP tool failed", 180);
    return new Text(`  ${theme.fg("error", "✗")} ${theme.fg("error", message)}`, 0, 0);
  }

  if (options.expanded) {
    const output = display.lines.map(line => theme.fg("toolOutput", line)).join("\n");
    return new Text(`  ${theme.fg("success", "✓")} ${theme.fg("muted", "completed")}\n${output}`, 0, 0);
  }

  const textLines = result.content
    .filter(block => block.type === "text")
    .flatMap(block => block.text.split("\n"))
    .filter(line => line.length > 0).length;
  const images = result.content.filter(block => block.type === "image").length;
  const parts: string[] = [];
  if (textLines > 0) parts.push(`${textLines} ${textLines === 1 ? "line" : "lines"}`);
  if (images > 0) parts.push(`${images} ${images === 1 ? "image" : "images"}`);
  const summary = parts.join(" · ") || "empty result";

  return new Text(
    `  ${theme.fg("success", "✓")} ${theme.fg("muted", summary)} ${theme.fg("dim", "·")} ${keyHint("app.tools.expand", "details")}`,
    0,
    0,
  );
}
