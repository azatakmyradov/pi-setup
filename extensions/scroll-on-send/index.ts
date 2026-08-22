import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ScrollView } from "@earendil-works/pi-tui";

/**
 * Scrolls the transcript to the end whenever the user sends a message while
 * scrolled up ("not pinned"). Pi creates exactly one primary ScrollView for
 * the fullscreen transcript (follow: "end"); the End keybinding already maps
 * to scrollToEnd(), which jumps to the bottom and re-enables follow. This
 * extension captures that view by patching ScrollView.prototype.updateLayout
 * once, then calls scrollToEnd() on every user input.
 *
 * The captured instance lives on globalThis (like ui-customizations) so a
 * reloaded copy of this extension shares it with the already-patched class.
 */

const SCROLL_VIEW_PATCH = Symbol.for("pi-setup:scroll-on-send:scroll-view-patch");

declare global {
  /**
   * The transcript ScrollView recorded by the prototype patch below. Declared
   * on globalThis so a reloaded copy of this extension reads the instance that
   * the already-patched class captured.
   */
  var piSetupTranscriptScrollView: ScrollView | undefined;
}

export function getTranscriptScrollView(): ScrollView | undefined {
  const view = globalThis.piSetupTranscriptScrollView;
  // A reloaded extension copy may see a view built from another ScrollView copy.
  return view instanceof ScrollView ? view : undefined;
}

/**
 * Records the primary ScrollView (pi's transcript) for later use. Only
 * mounted in fullscreen mode, so in regular mode nothing is ever captured
 * and the input handler becomes a no-op.
 */
export function installScrollViewCapture(): void {
  const prototype = ScrollView.prototype;
  if (SCROLL_VIEW_PATCH in prototype) return;

  // The prototype method is captured to be re-applied with the instance as `this`.
  // eslint-disable-next-line typescript/unbound-method
  const originalUpdateLayout = prototype.updateLayout;
  prototype.updateLayout = function (
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    if (this.primary) {
      globalThis.piSetupTranscriptScrollView = this;
    }
    originalUpdateLayout.call(this, contentHeight, viewportHeight, requestRender);
  };
  Object.defineProperty(prototype, SCROLL_VIEW_PATCH, { value: true });
}

/** Jumps to the transcript end when the user is not already following it. */
export function scrollTranscriptToEnd(view: ScrollView | undefined): void {
  if (!view || view.isFollowingEnd) return;
  view.scrollToEnd();
}

export function handleUserInput(mode: ExtensionContext["mode"]): void {
  if (mode !== "tui") return;
  scrollTranscriptToEnd(getTranscriptScrollView());
}

export default function (pi: ExtensionAPI) {
  installScrollViewCapture();
  pi.on("input", async (_event, ctx) => {
    handleUserInput(ctx.mode);
  });
}
