import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneWorkflowArtifacts } from "./retention.ts";

const NOW = 2_000_000_000_000;
const MAX_AGE_MS = 1_000;

function makeRun(baseDir: string, runId: string, ageMs: number, withWorkflow = true): string {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir);
  if (withWorkflow) {
    const workflowPath = join(runDir, "workflow.json");
    writeFileSync(workflowPath, "{}", "utf8");
    const modifiedAt = new Date(NOW - ageMs);
    utimesSync(workflowPath, modifiedAt, modifiedAt);
  } else {
    const modifiedAt = new Date(NOW - ageMs);
    utimesSync(runDir, modifiedAt, modifiedAt);
  }
  return runDir;
}

test("retention removes old workflow artifacts and keeps fresh ones", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-workflow-retention-"));
  try {
    const oldRun = makeRun(baseDir, "wf_old", MAX_AGE_MS + 1);
    const freshRun = makeRun(baseDir, "wf_fresh", MAX_AGE_MS - 1);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    assert.deepEqual(result, { removed: ["wf_old"] });
    assert.equal(existsSync(oldRun), false);
    assert.equal(existsSync(freshRun), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention never removes a kept active run", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-workflow-retention-"));
  try {
    const runDir = makeRun(baseDir, "wf_active", MAX_AGE_MS + 1);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(["wf_active"]),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    assert.deepEqual(result, { removed: [] });
    assert.equal(existsSync(runDir), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention falls back to directory age when workflow.json is missing", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-workflow-retention-"));
  try {
    const oldRun = makeRun(baseDir, "wf_missing_old", MAX_AGE_MS + 1, false);
    const freshRun = makeRun(baseDir, "wf_missing_fresh", MAX_AGE_MS - 1, false);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    assert.deepEqual(result, { removed: ["wf_missing_old"] });
    assert.equal(existsSync(oldRun), false);
    assert.equal(existsSync(freshRun), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention ignores entries without the workflow run prefix", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-workflow-retention-"));
  try {
    const otherDir = makeRun(baseDir, "other_old", MAX_AGE_MS + 1, false);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    assert.deepEqual(result, { removed: [] });
    assert.equal(existsSync(otherDir), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention tolerates a missing base directory", () => {
  const baseDir = join(tmpdir(), `pi-workflow-retention-missing-${process.pid}-${Date.now()}`);
  assert.deepEqual(
    pruneWorkflowArtifacts({ baseDir, keepRunIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW }),
    { removed: [] },
  );
});
