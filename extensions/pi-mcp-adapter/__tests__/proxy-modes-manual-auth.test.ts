import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  completeAuthFromInput: vi.fn(),
  startAuth: vi.fn(),
  supportsOAuth: vi.fn(),
  lazyConnect: vi.fn(),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  updateStatusBar: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: vi.fn(),
  completeAuthFromInput: mocks.completeAuthFromInput,
  startAuth: mocks.startAuth,
  supportsOAuth: mocks.supportsOAuth,
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  updateServerMetadata: mocks.updateServerMetadata,
  updateMetadataCache: mocks.updateMetadataCache,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
}));

function getText(content: { type: string }): string {
  if ("text" in content && typeof content.text === "string") return content.text;
  throw new Error(`Expected text content, received ${content.type}`);
}

function createState(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      settings: {},
      mcpServers: {
        demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        bearer: { url: "https://api.example.com/mcp", auth: "bearer" },
      },
    },
    manager: { close: vi.fn(async () => {}) },
    toolMetadata: new Map(),
    failureTracker: new Map([["demo", Date.now()]]),
    ...overrides,
  } as any;
}

describe("manual OAuth proxy actions", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.completeAuthFromInput.mockReset().mockResolvedValue("authenticated");
    mocks.startAuth.mockReset().mockResolvedValue({
      authorizationUrl: "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A19876%2Fcallback",
    });
    mocks.supportsOAuth.mockReset().mockImplementation((definition) => definition.auth === "oauth");
    mocks.updateStatusBar.mockReset();
  });

  it("returns copyable instructions and authorization URL", async () => {
    const { executeAuthStart } = await import("../proxy-modes.ts");
    const state = createState();

    const result = await executeAuthStart(state, "demo");

    expect(mocks.startAuth).toHaveBeenCalledWith("demo", "https://api.example.com/mcp", state.config.mcpServers.demo);
    expect(getText(result.content[0])).toContain("Open this URL in your local browser");
    expect(getText(result.content[0])).toContain("https://auth.example.com/authorize");
    expect(getText(result.content[0])).toContain("auth-complete");
    expect(result.details).toMatchObject({ mode: "auth-start", server: "demo" });
  });

  it("rejects auth-start for non-OAuth servers", async () => {
    const { executeAuthStart } = await import("../proxy-modes.ts");

    const result = await executeAuthStart(createState(), "bearer");

    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(getText(result.content[0])).toContain("not configured for OAuth");
    expect(result.details).toMatchObject({ error: "oauth_not_supported" });
  });

  it("completes auth from a copied redirect URL and resets connection state", async () => {
    const { executeAuthComplete } = await import("../proxy-modes.ts");
    const state = createState();

    const result = await executeAuthComplete(state, "demo", "http://localhost:19876/callback?code=abc&state=state");

    expect(mocks.completeAuthFromInput).toHaveBeenCalledWith("demo", "http://localhost:19876/callback?code=abc&state=state");
    expect(state.manager.close).toHaveBeenCalledWith("demo");
    expect(state.failureTracker.has("demo")).toBe(false);
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
    expect(getText(result.content[0])).toContain("OAuth authentication successful");
  });
});
