import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ThemeText } from "../shared/ui-kit.ts";
import { runWithLoader, type CustomComponentHost } from "./index.ts";

initTheme("dark", false);

type LoaderComponent = Component & { dispose?(): void };

/** The loader binds no app keybindings, so the double passes an empty stand-in. */
type UnusedKeybindings = Record<never, never>;

/** The loader only requests renders, colors text, and reports its result. */
type LoaderFactory<T> = (
  tui: Pick<TUI, "requestRender">,
  theme: ThemeText,
  keybindings: UnusedKeybindings,
  done: (result: T) => void,
) => LoaderComponent;

function createUi() {
  let component: LoaderComponent | undefined;
  const tui: Pick<TUI, "requestRender"> = { requestRender() {} };
  const theme: ThemeText = { fg: (_color, text) => text };

  // SAFETY: BorderedLoader reads only `requestRender` from the TUI and `fg` from
  // the theme, and ignores the keybindings manager, so this recorder can host it
  // even though it supplies none of the rest of the SDK's UI surface.
  const ui = {
    custom<T>(factory: LoaderFactory<T>): Promise<T> {
      return new Promise<T>((resolve) => {
        const done = (result: T) => {
          component?.dispose?.();
          resolve(result);
        };
        component = factory(tui, theme, {}, done);
      });
    },
  } as CustomComponentHost;

  return {
    ui,
    getComponent: () => {
      if (!component) throw new Error("Loader was not created");
      return component;
    },
  };
}

test("shows visible feedback while a commit operation is pending", async () => {
  const { ui, getComponent } = createUi();
  let finish!: (value: string) => void;
  let operationSignal: AbortSignal | undefined;

  const running = runWithLoader(
    ui,
    "Committing… Pre-commit hooks may take a while.",
    (signal) => {
      operationSignal = signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    "Commit cancelled",
  );

  assert.equal(operationSignal?.aborted, false);
  assert.match(
    getComponent().render(100).join("\n"),
    /Committing… Pre-commit hooks may take a while\./,
  );

  finish("Committed abc123: test commit");
  assert.equal(await running, "Committed abc123: test commit");
});

test("reports commit operation failures from the loader", async () => {
  const { ui } = createUi();

  await assert.rejects(
    runWithLoader(
      ui,
      "Committing… Pre-commit hooks may take a while.",
      async () => {
        throw new Error("pre-commit hook failed");
      },
      "Commit cancelled",
    ),
    /pre-commit hook failed/,
  );
});
