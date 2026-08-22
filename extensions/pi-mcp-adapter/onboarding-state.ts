import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { asJsonText, jsonObjectSchema } from "./json-value.ts";

export interface McpOnboardingState {
  version: 1;
  sharedConfigHintShown: boolean;
  setupCompleted: boolean;
  lastDiscoveryFingerprint?: string;
}

const DEFAULT_STATE: McpOnboardingState = {
  version: 1,
  sharedConfigHintShown: false,
  setupCompleted: false,
};

export function getOnboardingStatePath(): string {
  return getAgentPath("mcp-onboarding.json");
}

export function loadOnboardingState(): McpOnboardingState {
  const path = getOnboardingStatePath();
  if (!existsSync(path)) return { ...DEFAULT_STATE };

  try {
    const raw = jsonObjectSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!raw.success) return { ...DEFAULT_STATE };
    return {
      version: 1,
      sharedConfigHintShown: raw.data.sharedConfigHintShown === true,
      setupCompleted: raw.data.setupCompleted === true,
      lastDiscoveryFingerprint: asJsonText(raw.data.lastDiscoveryFingerprint),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveOnboardingState(state: McpOnboardingState): void {
  const path = getOnboardingStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

export function updateOnboardingState(updater: (state: McpOnboardingState) => McpOnboardingState): McpOnboardingState {
  const next = updater(loadOnboardingState());
  saveOnboardingState(next);
  return next;
}

export function markSharedConfigHintShown(fingerprint?: string): McpOnboardingState {
  return updateOnboardingState((state) => ({
    ...state,
    sharedConfigHintShown: true,
    lastDiscoveryFingerprint: fingerprint ?? state.lastDiscoveryFingerprint,
  }));
}

export function markSetupCompleted(fingerprint?: string): McpOnboardingState {
  return updateOnboardingState((state) => ({
    ...state,
    setupCompleted: true,
    lastDiscoveryFingerprint: fingerprint ?? state.lastDiscoveryFingerprint,
  }));
}
