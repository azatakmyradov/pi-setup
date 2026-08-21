import type { ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { logger } from "./logger.ts";
import { Effect, Fiber } from "effect";

export type ReconnectCallback = (serverName: string) => void;

export class McpLifecycleManager {
  private manager: McpServerManager;
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout: number = 10 * 60 * 1000;
  /** Compatibility-only health fiber for standalone consumers that still call
   * startHealthChecks directly. Session initialization uses the scoped
   * Effect LifecycleService instead. */
  private healthCheckFiber?: Fiber.Fiber<void>;
  private onReconnect?: ReconnectCallback;
  private onIdleShutdown?: (serverName: string) => void;

  constructor(manager: McpServerManager) {
    this.manager = manager;
  }

  /**
   * Set callback to be invoked after a successful auto-reconnect.
   * Use this to update tool metadata when a server reconnects.
   */
  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }

  markKeepAlive(name: string, definition: ServerDefinition): void {
    this.keepAliveServers.set(name, definition);
  }

  unmarkKeepAlive(name: string): void {
    this.keepAliveServers.delete(name);
  }

  isKeepAlive(name: string): boolean {
    return this.keepAliveServers.has(name);
  }

  registerServer(name: string, definition: ServerDefinition, settings?: { idleTimeout?: number }): void {
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  startHealthChecks(intervalMs = 30000): void {
    if (this.healthCheckFiber) return;
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30000;
    const healthCheck = Effect.tryPromise({
      try: () => this.checkConnectionsOnce(),
      catch: () => undefined,
    }).pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep(`${interval} millis`)),
    );
    this.healthCheckFiber = Effect.runFork(Effect.forever(healthCheck));
  }

  /** Run one health/idle pass. The Effect lifecycle service calls this from
   * a scoped fiber; startHealthChecks remains as a compatibility facade for
   * external consumers of the standalone adapter. */
  async checkConnectionsOnce(): Promise<void> {
    for (const [name, definition] of this.keepAliveServers) {
      const connection = this.manager.getConnection(name);

      if (!connection || connection.status !== "connected") {
        try {
          await this.manager.connect(name, definition);
          logger.debug(`Reconnected to ${name}`);
          // Notify extension to update metadata
          this.onReconnect?.(name);
        } catch (error) {
          console.error(`MCP: Failed to reconnect to ${name}:`, error);
        }
      }
    }

    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        this.onIdleShutdown?.(name);
      }
    }
  }

  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) return perServer * 60 * 1000;
    return this.globalIdleTimeout;
  }

  async gracefulShutdown(): Promise<void> {
    const fiber = this.healthCheckFiber;
    this.healthCheckFiber = undefined;
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
    await this.manager.closeAll();
  }
}
