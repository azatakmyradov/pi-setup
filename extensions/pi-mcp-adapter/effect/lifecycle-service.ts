import { Context, Effect, Fiber, Layer, Scope } from "effect";

export interface LifecycleServiceShape {
  readonly start: (intervalMs?: number) => Effect.Effect<void, never, Scope.Scope>;
  readonly stop: Effect.Effect<void>;
}

export class LifecycleService extends Context.Service<
  LifecycleService,
  LifecycleServiceShape
>()("pi-mcp-adapter/LifecycleService") {}

export interface LifecycleSource {
  readonly check: () => Promise<void>;
}

export interface LifecycleOptions {
  readonly autoStart?: boolean;
}

/**
 * Scoped health loop. It deliberately uses Effect's Clock and fiber scope
 * rather than a process-global timer, which makes runtime disposal and fake
 * clock tests deterministic.
 */
export function makeLifecycleLayer(
  source: LifecycleSource,
  options: LifecycleOptions = {},
): Layer.Layer<LifecycleService> {
  const service = Effect.gen(function* () {
    let fiber: Fiber.Fiber<void> | undefined;

    const start = (intervalMs = 30_000): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function* () {
      if (fiber) return;
      const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000;
      const loop = Effect.gen(function* () {
        while (true) {
          yield* Effect.tryPromise({
            try: () => source.check(),
            catch: () => undefined,
          }).pipe(Effect.ignore);
          yield* Effect.sleep(`${interval} millis`);
        }
      });
      fiber = yield* loop.pipe(Effect.forkScoped({ startImmediately: true }));
    });

    const stop: Effect.Effect<void> = Effect.gen(function* () {
      const current = fiber;
      fiber = undefined;
      if (current) yield* Fiber.interrupt(current);
    });

    if (options.autoStart) yield* start();
    yield* Effect.addFinalizer(() => stop);
    return LifecycleService.of({ start, stop });
  });

  return Layer.effect(LifecycleService, service);
}
