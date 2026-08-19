import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { LOADER_FRAMES, statusGlyph } from "../../../shared/ui-kit.ts";
import type {
  BackendName,
  LiveToolState,
  SubagentSnapshot,
} from "../domain.ts";
import { formatElapsed } from "../domain.ts";
import type { SubagentReadModel } from "../manager.ts";
import { sanitizeText } from "./transcript.ts";

export const CHAT_ROW_INVALIDATE_MS = 50;
const LOADER_INTERVAL_MS = 80;

type ChatRowView = Pick<SubagentReadModel, "get" | "subscribeTo">;
type FallbackStatus = "starting" | "started" | "failed";

export interface SubagentChatRowOptions {
  readonly onSubscriptionChange?: (
    row: SubagentChatRow,
    active: boolean,
  ) => void;
}

const BACKEND_LABELS: Record<BackendName, string> = {
  pi: "Pi",
  claude: "Claude",
  codex: "Codex",
};

function inline(text: string): string {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}

function toolLabel(name: string): string {
  return inline(name)
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parsedToolDetail(preview: string | undefined): string {
  const clean = inline(preview ?? "");
  if (!clean || clean === "{}") return "";

  try {
    const parsed: unknown = JSON.parse(clean);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = parsed as Record<string, unknown>;
      for (const key of ["path", "command", "query", "pattern", "url"]) {
        if (typeof values[key] === "string") return inline(values[key]);
      }
      const firstString = Object.values(values).find(
        (value): value is string => typeof value === "string",
      );
      if (firstString) return inline(firstString);
    }
  } catch {
    // Native backends may provide a compact non-JSON preview.
  }

  return clean;
}

function activityText(tool: LiveToolState): string {
  const detail =
    parsedToolDetail(tool.argsPreview) || parsedToolDetail(tool.outputPreview);
  return `${toolLabel(tool.name) || "Tool"}${detail ? ` ${detail}` : ""}`;
}

function cloneSnapshot(snapshot: SubagentSnapshot): SubagentSnapshot {
  return {
    ...snapshot,
    meta: { ...snapshot.meta },
    usage: { ...snapshot.usage },
    transcript: [...snapshot.transcript],
    liveAssistant: snapshot.liveAssistant
      ? { ...snapshot.liveAssistant }
      : undefined,
    liveTools: snapshot.liveTools.map((tool) => ({ ...tool })),
    queued: [...snapshot.queued],
  };
}

function wasCancelled(snapshot: SubagentSnapshot): boolean {
  return (
    snapshot.errorText === "Run was aborted" ||
    snapshot.errorText ===
      "Abort deadline exceeded; session was force-disposed"
  );
}

/** Compact persistent renderer for one subagent_spawn tool row. */
export class SubagentChatRow implements Component {
  private backend: BackendName;
  private title: string;
  private theme: Theme;
  private fallbackStatus: FallbackStatus = "starting";
  private snapshot?: SubagentSnapshot;
  /** Retained between tools so the activity line does not collapse and jitter. */
  private recentTool?: LiveToolState;
  private view?: ChatRowView;
  private id?: string;
  private requestInvalidate?: () => void;
  private unsubscribe?: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private loaderTimer?: ReturnType<typeof setInterval>;
  private loaderFrameIndex = 0;
  private disposed = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly options: SubagentChatRowOptions;

  constructor(
    backend: BackendName,
    title: string,
    theme: Theme,
    options: SubagentChatRowOptions = {},
  ) {
    this.backend = backend;
    this.title = inline(title) || "subagent";
    this.theme = theme;
    this.options = options;
  }

  update(backend: BackendName, title: string, theme: Theme): void {
    const nextTitle = inline(title) || "subagent";
    if (
      this.backend !== backend ||
      this.title !== nextTitle ||
      this.theme !== theme
    ) {
      this.backend = backend;
      this.title = nextTitle;
      this.theme = theme;
      this.invalidate();
    }
  }

  setRequestInvalidate(requestInvalidate: () => void): void {
    if (this.disposed) return;
    this.requestInvalidate = requestInvalidate;
    this.syncLoader();
  }

  markStarted(): void {
    this.fallbackStatus = "started";
    this.snapshot = undefined;
    this.recentTool = undefined;
    this.stopSubscription();
    this.syncLoader();
    this.invalidate();
  }

  markFailed(): void {
    this.fallbackStatus = "failed";
    this.snapshot = undefined;
    this.recentTool = undefined;
    this.stopSubscription();
    this.syncLoader();
    this.invalidate();
  }

  connect(
    view: ChatRowView,
    id: string,
    requestInvalidate: () => void,
  ): void {
    if (this.disposed) return;
    this.setRequestInvalidate(requestInvalidate);

    if (this.view === view && this.id === id) {
      this.captureSnapshot();
      return;
    }

    this.stopSubscription();
    this.view = view;
    this.id = id;
    this.unsubscribe = view.subscribeTo(id, () => this.handleSnapshotChange());
    this.options.onSubscriptionChange?.(this, true);
    this.captureSnapshot();
  }

  private captureSnapshot(): void {
    const snapshot = this.id ? this.view?.get(this.id) : undefined;
    this.snapshot = snapshot ? cloneSnapshot(snapshot) : undefined;
    const latestTool = this.snapshot?.liveTools.at(-1);
    if (this.snapshot?.status !== "running") this.recentTool = undefined;
    else if (latestTool) this.recentTool = { ...latestTool };
    this.syncLoader();
    this.invalidate();
    if (this.snapshot?.status !== "running") this.stopSubscription();
  }

  private syncLoader(): void {
    const active =
      this.snapshot?.status === "running" ||
      (!this.snapshot && this.fallbackStatus === "starting");
    if (active && this.requestInvalidate && !this.loaderTimer) {
      this.loaderTimer = setInterval(() => {
        this.loaderFrameIndex =
          (this.loaderFrameIndex + 1) % LOADER_FRAMES.length;
        this.invalidate();
        this.requestInvalidate?.();
      }, LOADER_INTERVAL_MS);
    } else if (!active && this.loaderTimer) {
      clearInterval(this.loaderTimer);
      this.loaderTimer = undefined;
      this.loaderFrameIndex = 0;
    }
  }

  private loaderFrame(): string {
    return this.theme.fg(
      "accent",
      LOADER_FRAMES[this.loaderFrameIndex] ?? LOADER_FRAMES[0],
    );
  }

  private handleSnapshotChange(): void {
    this.captureSnapshot();
    if (this.disposed || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.disposed) this.requestInvalidate?.();
    }, CHAT_ROW_INVALIDATE_MS);
  }

  private stopSubscription(): void {
    const unsubscribe = this.unsubscribe;
    if (!unsubscribe) return;
    this.unsubscribe = undefined;
    unsubscribe();
    this.options.onSubscriptionChange?.(this, false);
  }

  private status(): {
    readonly glyph: string;
    readonly label: string;
    readonly elapsed?: string;
  } {
    const snapshot = this.snapshot;
    if (snapshot?.status === "running") {
      return {
        glyph: this.loaderFrame(),
        label: this.theme.fg("warning", "Background"),
      };
    }
    if (snapshot?.status === "done") {
      return {
        glyph: statusGlyph(this.theme, "success"),
        label: this.theme.fg("success", "Done"),
        elapsed: formatElapsed(snapshot),
      };
    }
    if (snapshot?.status === "error") {
      const cancelled = wasCancelled(snapshot);
      return {
        glyph: statusGlyph(this.theme, "error"),
        label: this.theme.fg(
          cancelled ? "warning" : "error",
          cancelled ? "Cancelled" : "Failed",
        ),
        elapsed: formatElapsed(snapshot),
      };
    }
    if (this.fallbackStatus === "failed") {
      return {
        glyph: statusGlyph(this.theme, "error"),
        label: this.theme.fg("error", "Failed"),
      };
    }
    return {
      glyph:
        this.fallbackStatus === "starting"
          ? this.loaderFrame()
          : statusGlyph(this.theme, "pending"),
      label: this.theme.fg(
        this.fallbackStatus === "starting" ? "warning" : "muted",
        this.fallbackStatus === "starting" ? "Starting" : "Started",
      ),
    };
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (this.cachedLines && this.cachedWidth === safeWidth) {
      return this.cachedLines;
    }

    const status = this.status();
    const backend = this.theme.fg(
      "toolTitle",
      this.theme.bold(`${BACKEND_LABELS[this.backend]} Subagent`),
    );
    const title = this.theme.fg("text", this.title);
    const suffix =
      status.label +
      (status.elapsed
        ? this.theme.fg("muted", ` · ${status.elapsed}`)
        : "");
    const lines = [
      truncateToWidth(
        `${status.glyph} ${backend}${this.theme.fg("muted", " — ")}${title}  ${suffix}`,
        safeWidth,
        "…",
      ),
    ];

    if (this.snapshot?.status === "running") {
      const tool = this.snapshot.liveTools.at(-1) ?? this.recentTool;
      if (tool) {
        lines.push(
          truncateToWidth(
            this.theme.fg("muted", `  ↳ ${activityText(tool)}`),
            safeWidth,
            "…",
          ),
        );
      }
    }

    this.cachedWidth = safeWidth;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSubscription();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.loaderTimer) clearInterval(this.loaderTimer);
    this.renderTimer = undefined;
    this.loaderTimer = undefined;
  }
}
