import { describe, expect, it, vi } from "vite-plus/test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createRuntimeLoader,
  type McpRuntimeSession,
  type RuntimeEntryModule,
} from "../runtime-loader.ts";

// SAFETY: runtime-loader tests replace the initializer, which only forwards this value.
const UNUSED_EXTENSION_API = {} as ExtensionAPI;
// SAFETY: runtime-loader tests replace the initializer, which only forwards this value.
const UNUSED_EXTENSION_CONTEXT = {} as ExtensionContext;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function runtimeSession(): McpRuntimeSession {
  return {
    activate: vi.fn(),
    executeDirect: vi.fn(),
    executeCodeMode: vi.fn(),
    executeProxy: vi.fn(),
    executeCommand: vi.fn(),
    executeAuthCommand: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function loaderFor(
  initializeRuntime: RuntimeEntryModule["initializeRuntime"],
  isCurrent = () => true,
) {
  const importRuntime = vi.fn().mockResolvedValue({ initializeRuntime });
  return {
    importRuntime,
    loader: createRuntimeLoader(
      UNUSED_EXTENSION_API,
      UNUSED_EXTENSION_CONTEXT,
      undefined,
      isCurrent,
      importRuntime,
    ),
  };
}

describe("lazy MCP runtime loader", () => {
  it("does not import or initialize until first use", async () => {
    const session = runtimeSession();
    const initializeRuntime = vi.fn().mockResolvedValue(session);
    const { importRuntime, loader } = loaderFor(initializeRuntime);

    expect(importRuntime).not.toHaveBeenCalled();
    expect(initializeRuntime).not.toHaveBeenCalled();

    await loader.load();

    expect(importRuntime).toHaveBeenCalledTimes(1);
    expect(initializeRuntime).toHaveBeenCalledTimes(1);
    expect(session.activate).toHaveBeenCalledTimes(1);
  });

  it("shares one initialization across concurrent first calls", async () => {
    const deferred = createDeferred<McpRuntimeSession>();
    const initializeRuntime = vi.fn().mockReturnValue(deferred.promise);
    const { importRuntime, loader } = loaderFor(initializeRuntime);

    const first = loader.load();
    const second = loader.load();
    const session = runtimeSession();
    deferred.resolve(session);

    await expect(first).resolves.toBe(session);
    await expect(second).resolves.toBe(session);
    expect(importRuntime).toHaveBeenCalledTimes(1);
    expect(initializeRuntime).toHaveBeenCalledTimes(1);
  });

  it("caches import and initialization failures for the session", async () => {
    const importError = new Error("runtime import failed");
    const importRuntime = vi.fn().mockRejectedValue(importError);
    const loader = createRuntimeLoader(
      UNUSED_EXTENSION_API,
      UNUSED_EXTENSION_CONTEXT,
      undefined,
      () => true,
      importRuntime,
    );

    await expect(loader.load()).rejects.toBe(importError);
    await expect(loader.load()).rejects.toBe(importError);
    expect(importRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not import runtime code when shutdown happens before first use", async () => {
    const initializeRuntime = vi.fn().mockResolvedValue(runtimeSession());
    const { importRuntime, loader } = loaderFor(initializeRuntime);

    await loader.shutdown("session_shutdown");

    expect(importRuntime).not.toHaveBeenCalled();
    expect(initializeRuntime).not.toHaveBeenCalled();
  });

  it("does not initialize when shutdown wins a pending module import", async () => {
    const deferredImport = createDeferred<RuntimeEntryModule>();
    const initializeRuntime = vi.fn().mockResolvedValue(runtimeSession());
    const importRuntime = vi.fn().mockReturnValue(deferredImport.promise);
    const loader = createRuntimeLoader(
      UNUSED_EXTENSION_API,
      UNUSED_EXTENSION_CONTEXT,
      undefined,
      () => true,
      importRuntime,
    );

    const pendingLoad = loader.load();
    const pendingShutdown = loader.shutdown("session_shutdown");
    deferredImport.resolve({ initializeRuntime });

    await expect(pendingLoad).rejects.toThrow("no longer active");
    await pendingShutdown;
    expect(initializeRuntime).not.toHaveBeenCalled();
  });

  it("disposes a session that finishes initializing after shutdown", async () => {
    const deferred = createDeferred<McpRuntimeSession>();
    const initializeRuntime = vi.fn().mockReturnValue(deferred.promise);
    const { loader } = loaderFor(initializeRuntime);
    const pendingLoad = loader.load();
    await vi.waitFor(() => expect(initializeRuntime).toHaveBeenCalledTimes(1));
    const pendingShutdown = loader.shutdown("session_shutdown");
    const session = runtimeSession();

    deferred.resolve(session);

    await expect(pendingLoad).rejects.toThrow("replaced");
    await pendingShutdown;
    expect(session.activate).not.toHaveBeenCalled();
    expect(session.shutdown).toHaveBeenCalledWith("session_shutdown");
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it("disposes stale initialization and lets a fresh loader initialize", async () => {
    const staleSession = runtimeSession();
    const activeSession = runtimeSession();
    const initializeRuntime = vi.fn()
      .mockResolvedValueOnce(staleSession)
      .mockResolvedValueOnce(activeSession);
    const importRuntime = vi.fn().mockResolvedValue({ initializeRuntime });

    const stale = createRuntimeLoader(
      UNUSED_EXTENSION_API,
      UNUSED_EXTENSION_CONTEXT,
      undefined,
      () => false,
      importRuntime,
    );
    await expect(stale.load()).rejects.toThrow("replaced");
    expect(staleSession.shutdown).toHaveBeenCalledWith("session_shutdown");

    const fresh = createRuntimeLoader(
      UNUSED_EXTENSION_API,
      UNUSED_EXTENSION_CONTEXT,
      undefined,
      () => true,
      importRuntime,
    );
    await expect(fresh.load()).resolves.toBe(activeSession);
    expect(activeSession.activate).toHaveBeenCalledTimes(1);
    expect(initializeRuntime).toHaveBeenCalledTimes(2);
  });
});
