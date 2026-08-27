import assert from "node:assert/strict";
import test from "node:test";
import { TpsTracker } from "./tps.ts";

test("reports output tokens per second after the first second", () => {
  const tps = new TpsTracker();
  tps.start(0);
  tps.observe(400, 500);
  assert.equal(tps.tokensPerSecond(), undefined);

  tps.observe(920, 1_000);
  assert.equal(tps.tokensPerSecond(), 920);
  tps.observe(1_840, 1_100);
  assert.equal(tps.tokensPerSecond(), 920);
  tps.observe(1_840, 1_300);
  assert.equal(tps.tokensPerSecond(), 1_415);
});

test("holds the completed rate until another full sample is available", () => {
  const tps = new TpsTracker();
  tps.start(0);
  tps.observe(460, 5_000);
  tps.stop(460, 5_500);
  assert.equal(tps.tokensPerSecond(), 84);

  tps.start(6_000);
  tps.observe(30, 6_400);
  tps.stop(30, 6_400);
  assert.equal(tps.tokensPerSecond(), 84);
});

test("stays hidden when the provider reports no output tokens", () => {
  const tps = new TpsTracker();
  tps.start(0);
  tps.observe(undefined, 5_000);
  tps.stop(undefined, 7_000);
  assert.equal(tps.tokensPerSecond(), undefined);
});
