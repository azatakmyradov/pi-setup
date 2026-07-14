import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function alignColumns(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (!right) return truncateToWidth(left, width, "…");

  const minGap = 2;
  const maxRightWidth = Math.max(1, Math.floor(width * 0.55));
  const fittedRight = truncateToWidth(right, maxRightWidth, "…");
  const rightWidth = visibleWidth(fittedRight);
  const availableLeft = width - rightWidth - minGap;

  if (availableLeft <= 0) return truncateToWidth(fittedRight, width, "…");

  const fittedLeft = truncateToWidth(left, availableLeft, "…");
  const padding = " ".repeat(Math.max(minGap, width - visibleWidth(fittedLeft) - rightWidth));
  return fittedLeft + padding + fittedRight;
}

function thinkingLabel(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const level = pi.getThinkingLevel();
  const label = level === "off" ? "thinking off" : level;

  switch (level) {
    case "minimal":
      return ctx.ui.theme.fg("thinkingMinimal", label);
    case "low":
      return ctx.ui.theme.fg("thinkingLow", label);
    case "medium":
      return ctx.ui.theme.fg("thinkingMedium", label);
    case "high":
      return ctx.ui.theme.fg("thinkingHigh", label);
    case "xhigh":
      return ctx.ui.theme.fg("thinkingXhigh", label);
    case "max":
      return ctx.ui.theme.fg("thinkingMax", label);
    default:
      return ctx.ui.theme.fg("dim", label);
  }
}

function contextLabel(ctx: ExtensionContext, width: number): string {
  const theme = ctx.ui.theme;
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = usage?.percent;
  const percentText = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
  const totalText = contextWindow > 0 ? formatTokens(contextWindow) : "?";
  const color = percent !== null && percent !== undefined && percent > 90
    ? "error"
    : percent !== null && percent !== undefined && percent > 70
      ? "warning"
      : "accent";

  let progress = "";
  if (percent !== null && percent !== undefined && width >= 72) {
    const barWidth = width >= 110 ? 10 : 6;
    const filled = Math.max(0, Math.min(barWidth, Math.round((percent / 100) * barWidth)));
    progress = ` ${theme.fg(color, "━".repeat(filled))}${theme.fg("borderMuted", "─".repeat(barWidth - filled))}`;
  }

  return `${theme.fg("dim", "ctx")}${progress} ${theme.fg(color, `${percentText}/${totalText}`)}`;
}

function isUsingSubscription(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  if (ctx.modelRegistry.isUsingOAuth(model)) return true;
  if (model.provider !== "openai-codex-fast") return false;

  const builtInModel = ctx.modelRegistry.find("openai-codex", model.id);
  return builtInModel ? ctx.modelRegistry.isUsingOAuth(builtInModel) : false;
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const branch = footerData.getGitBranch();
        const sessionName = ctx.sessionManager.getSessionName();
        const locationParts = [theme.fg("text", formatCwd(ctx.cwd))];

        if (branch) locationParts.push(theme.fg("accent", `(${sanitize(branch)})`));
        if (sessionName) {
          locationParts.push(theme.fg("dim", "•"));
          locationParts.push(theme.fg("muted", sanitize(sessionName)));
        }

        const model = ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : "no model";
        const modelInfo = [
          theme.fg("muted", sanitize(model)),
          theme.fg("dim", "•"),
          thinkingLabel(pi, ctx),
        ].join(" ");

        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let cost = 0;
        let latestCacheHit: number | undefined;

        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "message" || entry.message.role !== "assistant") continue;

          const usage = entry.message.usage;
          input += usage.input;
          output += usage.output;
          cacheRead += usage.cacheRead;
          cacheWrite += usage.cacheWrite;
          cost += usage.cost.total;

          const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
          latestCacheHit = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
        }

        const separator = theme.fg("dim", "·");
        const stats: string[] = [];
        if (input > 0) stats.push(theme.fg("muted", `↑${formatTokens(input)}`));
        if (output > 0) stats.push(theme.fg("muted", `↓${formatTokens(output)}`));
        if (cacheRead > 0) stats.push(theme.fg("dim", `R${formatTokens(cacheRead)}`));
        if (cacheWrite > 0) stats.push(theme.fg("dim", `W${formatTokens(cacheWrite)}`));
        if (latestCacheHit !== undefined && (cacheRead > 0 || cacheWrite > 0)) {
          stats.push(theme.fg("success", `cache ${latestCacheHit.toFixed(1)}%`));
        }

        const usingSubscription = isUsingSubscription(ctx);
        if (cost > 0 || usingSubscription) {
          stats.push(theme.fg("warning", `$${cost.toFixed(3)}${usingSubscription ? " sub" : ""}`));
        }
        if (stats.length === 0) stats.push(theme.fg("dim", "No usage yet"));

        const lines = [
          alignColumns(locationParts.join(" "), modelInfo, width),
          alignColumns(stats.join(` ${separator} `), contextLabel(ctx, width), width),
        ];

        const statuses = [...footerData.getExtensionStatuses().entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, status]) => sanitize(status))
          .filter(Boolean);

        if (statuses.length > 0) {
          const statusPrefix = theme.fg("accent", "●");
          lines.push(truncateToWidth(`${statusPrefix} ${statuses.join(` ${separator} `)}`, width, "…"));
        }

        return lines;
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui" && enabled) installFooter(pi, ctx);
  });

  pi.registerCommand("statusbar", {
    description: "Toggle the custom status bar",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      enabled = requested === "on" ? true : requested === "off" ? false : !enabled;

      if (enabled) {
        installFooter(pi, ctx);
        ctx.ui.notify("Custom status bar enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default status bar restored", "info");
      }
    },
  });
}
