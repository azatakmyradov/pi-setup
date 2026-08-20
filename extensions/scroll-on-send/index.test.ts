import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, type Component } from "@earendil-works/pi-tui";
import {
  getTranscriptScrollView,
  handleUserInput,
  installScrollViewCapture,
  scrollTranscriptToEnd,
} from "./index.ts";

const TRANSCRIPT_VIEW = Symbol.for("pi-setup:scroll-on-send:transcript-view");
const SCROLL_VIEW_PATCH = Symbol.for("pi-setup:scroll-on-send:scroll-view-patch");

function blankComponent(): Component {
  return {
    render: () => ["line"],
    invalidate: () => {},
  };
}

function createTranscriptView(): ScrollView {
  return new ScrollView(blankComponent(), { follow: "end", primary: true });
}

test("capture stores the primary scroll view after a layout pass", () => {
  installScrollViewCapture();
  (globalThis as unknown as Record<PropertyKey, unknown>)[TRANSCRIPT_VIEW] = undefined;

  const view = createTranscriptView();
  view.updateLayout(100, 10, () => {});

  assert.equal(getTranscriptScrollView(), view);
});

test("capture ignores non-primary views", () => {
  installScrollViewCapture();
  const primary = createTranscriptView();
  primary.updateLayout(100, 10, () => {});

  const sidePanel = new ScrollView(blankComponent(), { follow: "end" });
  sidePanel.updateLayout(50, 10, () => {});

  assert.equal(getTranscriptScrollView(), primary);
});

test("installing the capture twice keeps a single patched updateLayout", () => {
  installScrollViewCapture();
  installScrollViewCapture();

  assert.equal(SCROLL_VIEW_PATCH in ScrollView.prototype, true);

  (globalThis as unknown as Record<PropertyKey, unknown>)[TRANSCRIPT_VIEW] = undefined;
  const view = createTranscriptView();
  view.updateLayout(40, 10, () => {});
  assert.equal(getTranscriptScrollView(), view);
});

test("scrolls to the end when the user is scrolled up", () => {
  const view = createTranscriptView();
  view.updateLayout(100, 10, () => {});
  view.scrollTo(0);
  assert.equal(view.isFollowingEnd, false);

  scrollTranscriptToEnd(view);

  assert.equal(view.scrollTop, 90);
  assert.equal(view.isFollowingEnd, true);
});

test("does not touch the view when already following the end", () => {
  const view = createTranscriptView();
  view.updateLayout(100, 10, () => {});
  assert.equal(view.isFollowingEnd, true);

  let calls = 0;
  // Monitored via `original.call(view)` below, so the reference is intentional.
  // eslint-disable-next-line typescript/unbound-method
  const original = view.scrollToEnd;
  view.scrollToEnd = () => {
    calls += 1;
    original.call(view);
  };

  scrollTranscriptToEnd(view);
  assert.equal(calls, 0);
});

test("ignores a missing view", () => {
  scrollTranscriptToEnd(undefined);
});

test("handleUserInput only acts in tui mode", () => {
  installScrollViewCapture();
  const view = createTranscriptView();
  view.updateLayout(100, 10, () => {});
  view.scrollTo(0);

  handleUserInput("print");
  assert.equal(view.scrollTop, 0);
  assert.equal(view.isFollowingEnd, false);

  handleUserInput("tui");
  assert.equal(view.scrollTop, 90);
  assert.equal(view.isFollowingEnd, true);
});
