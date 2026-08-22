import { describe, expect, it } from "vite-plus/test";
import { ConsentManager } from "../consent-manager.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { executeUiMessages } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

function createState(prompts: string[]): McpExtensionState {
  const manager = new McpServerManager();
  return {
    config: { mcpServers: {} },
    manager,
    lifecycle: new McpLifecycleManager(manager),
    toolMetadata: new Map(),
    projectCwd: "",
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    consentManager: new ConsentManager("never"),
    uiServer: null,
    completedUiSessions: [
      {
        serverName: "interactive-visualizer",
        toolName: "show_visualization",
        completedAt: new Date("2026-03-12T16:00:00Z"),
        reason: "done",
        messages: {
          prompts,
          notifications: [],
          intents: [],
        },
      },
    ],
    openBrowser: async () => {},
  };
}

describe("executeUiMessages", () => {
  it("normalizes canonical handoff prompts into structured intents", () => {
    const state = createState([
      'visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[{"id":"a1","kind":"pin","text":"Check this"}]}',
    ]);

    const result = executeUiMessages(state);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("visualization_annotations_submitted"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.not.stringContaining("### Prompts:\n- visualization_annotations_submitted"),
    });
    expect(result.details).toMatchObject({
      intents: [
        {
          intent: "visualization_annotations_submitted",
          params: {
            visualizationId: "flow",
            annotations: [{ id: "a1", kind: "pin", text: "Check this" }],
          },
        },
      ],
      handoffs: [
        {
          intent: "visualization_annotations_submitted",
          params: {
            visualizationId: "flow",
            annotations: [{ id: "a1", kind: "pin", text: "Check this" }],
          },
        },
      ],
      cleared: true,
    });
    expect(state.completedUiSessions).toEqual([]);
  });

  it("preserves ordinary prompts as prompts", () => {
    const state = createState(["Please analyze this flow"]);
    const result = executeUiMessages(state);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("### Prompts:\n- Please analyze this flow"),
    });
    expect(result.details).toMatchObject({
      prompts: ["Please analyze this flow"],
      intents: [],
    });
  });
});
