import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { z } from "zod";

interface ProjectServerState {
  keepAlive: boolean;
  updatedAt: number;
}

interface McpProjectState {
  version: 1;
  projects: Record<string, { servers: Record<string, ProjectServerState> }>;
}

const projectServerStateSchema = z.object({
  keepAlive: z.boolean(),
  updatedAt: z.number(),
});

/**
 * Decodes the persisted project state. Every level falls back to an empty map so that one
 * unreadable project or server entry costs only that entry, matching how the readers below
 * already treat missing members.
 */
const projectStateSchema = z.looseObject({
  projects: z
    .record(
      z.string(),
      z
        .looseObject({ servers: z.record(z.string(), projectServerStateSchema).catch({}) })
        .catch({ servers: {} }),
    )
    .catch({}),
});

export function getProjectStatePath(): string {
  return getAgentPath("mcp-project-state.json");
}

export function canonicalProjectPath(cwd?: string): string {
  const absolute = resolve(cwd ?? process.cwd());
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function loadState(): McpProjectState {
  const path = getProjectStatePath();
  if (!existsSync(path)) return { version: 1, projects: {} };
  try {
    const value = projectStateSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!value.success) {
      return { version: 1, projects: {} };
    }
    return { version: 1, projects: value.data.projects };
  } catch {
    return { version: 1, projects: {} };
  }
}

function saveState(state: McpProjectState): void {
  const path = getProjectStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(temporary, path);
}

export function getRememberedServers(cwd: string): Set<string> {
  const servers = loadState().projects[canonicalProjectPath(cwd)]?.servers ?? {};
  return new Set(Object.entries(servers).filter(([, value]) => value?.keepAlive === true).map(([name]) => name));
}

export function rememberServer(cwd: string | undefined, serverName: string): void {
  const state = loadState();
  const key = canonicalProjectPath(cwd);
  const project = state.projects[key] ?? { servers: {} };
  project.servers[serverName] = { keepAlive: true, updatedAt: Date.now() };
  state.projects[key] = project;
  saveState(state);
}

export function forgetServer(cwd: string | undefined, serverName: string): void {
  const state = loadState();
  const key = canonicalProjectPath(cwd);
  const project = state.projects[key];
  if (!project?.servers[serverName]) return;
  delete project.servers[serverName];
  if (Object.keys(project.servers).length === 0) delete state.projects[key];
  saveState(state);
}
