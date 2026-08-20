import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { runWithLoader } from "./index.ts";

initTheme("dark", false);

function createUi() {
  let component: (Component & { dispose?(): void }) | undefined;
  const tui = { requestRender() {} };
  const theme = {
    fg: (_color: string, text: string) => text,
  };

  const ui = {
    custom(factory: (...args: unknown[]) => unknown) {
      return new Promise((resolve) => {
        const done = (result: unknown) => {
          component?.dispose?.();
          resolve(result);
        };
        component = factory(tui, theme, {}, done) as Component & { dispose?(): void };
      });
    },
  } as unknown as ExtensionUIContext;

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
