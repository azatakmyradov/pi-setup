// npx-resolver.ts - Resolve npx/npm exec binaries to avoid npm parent processes
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface NpxCacheEntry {
  resolvedBin: string;
  resolvedAt: number;
  packageVersion?: string;
  isJs: boolean;
}

interface NpxCache {
  version: number;
  entries: Record<string, NpxCacheEntry>;
}

/**
 * npm's `bin` field is either a single executable path or a name-to-path map.
 * Decoding it into these two cases lets the resolver branch on which kind of
 * declaration a package made instead of on how the value is represented.
 */
const packageBinSchema = z.union([
  z.string().transform((path) => ({ kind: "single" as const, path })),
  z.record(z.string(), z.string()).transform((entries) => ({ kind: "named" as const, entries })),
]);

/** The members of a cached package manifest this resolver reads. */
const packageManifestSchema = z.looseObject({
  bin: packageBinSchema.optional().catch(undefined),
  version: z.string().optional().catch(undefined),
});

type PackageManifest = z.infer<typeof packageManifestSchema>;

const npxCacheEntrySchema = z.looseObject({
  resolvedBin: z.string(),
  resolvedAt: z.number(),
  packageVersion: z.string().optional().catch(undefined),
  isJs: z.boolean(),
});

/**
 * Decodes the resolver's own cache document. The resolver owns this file, so a
 * document that no longer matches the current form is simply unreadable and
 * binaries are resolved again — the same outcome as a version bump.
 */
const npxCacheSchema = z.looseObject({
  version: z.literal(CACHE_VERSION),
  entries: z.record(z.string(), npxCacheEntrySchema),
});

export interface NpxResolution {
  binPath: string;
  extraArgs: string[];
  isJs: boolean;
}

interface ParsedInvocation {
  packageSpec: string;
  binName?: string;
  extraArgs: string[];
}

export async function resolveNpxBinary(
  command: string,
  args: string[]
): Promise<NpxResolution | null> {
  const parsed = command === "npx"
    ? parseNpxArgs(args)
    : command === "npm"
      ? parseNpmExecArgs(args)
      : null;

  if (!parsed) return null;

  const cacheKey = JSON.stringify([command, ...args]);
  const cache = loadCache();
  const cached = cache?.entries?.[cacheKey];

  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS && existsSync(cached.resolvedBin)) {
    return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs };
  }

  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolved) {
    saveCacheEntry(cacheKey, resolved);
    return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs };
  }

  // Slow path: force npx cache population
  await forceNpxCache(parsed.packageSpec);
  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolvedAfterInstall) {
    saveCacheEntry(cacheKey, resolvedAfterInstall);
    return { binPath: resolvedAfterInstall.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolvedAfterInstall.isJs };
  }

  return null;
}

function parseNpxArgs(args: string[]): ParsedInvocation | null {
  const separatorIndex = args.indexOf("--");
  const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  const positionals: string[] = [];
  let packageSpec: string | undefined;
  let sawPackageFlag = false;
  let foundFirstPositional = false;

  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (foundFirstPositional) {
      positionals.push(arg);
      continue;
    }
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "-p" || arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
    positionals.push(arg);
    foundFirstPositional = true;
  }

  const separatedAfter = separatorIndex >= 0 && after.length > 0 ? ["--", ...after] : after;

  if (sawPackageFlag) {
    const binName = positionals[0];
    if (!packageSpec || !binName) return null;
    const extraArgs = positionals.slice(1).concat(separatedAfter);
    return { packageSpec, binName, extraArgs };
  }

  const packagePositional = positionals[0];
  if (!packagePositional) return null;
  const extraArgs = positionals.slice(1).concat(separatedAfter);
  return { packageSpec: packagePositional, extraArgs };
}

function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
  if (args[0] !== "exec") return null;
  const execArgs = args.slice(1);
  const separatorIndex = execArgs.indexOf("--");
  if (separatorIndex < 0) return null;

  const before = execArgs.slice(0, separatorIndex);
  const after = execArgs.slice(separatorIndex + 1);

  let packageSpec: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--package") {
      const value = before[i + 1];
      if (!value || value.startsWith("-")) return null;
      if (!packageSpec) packageSpec = value;
      i++;
      continue;
    }
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      continue;
    }
    if (arg.startsWith("-")) {
      return null;
    }
  }

  const binName = after[0];
  if (!packageSpec || !binName) return null;
  const extraArgs = after.slice(1);
  return { packageSpec, binName, extraArgs };
}

function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {
  const cacheDir = getNpmCacheDir();
  if (!cacheDir) return null;

  const packageName = extractPackageName(packageSpec);
  if (!packageName) return null;

  const packageDir = findCachedPackageDir(cacheDir, packageName);
  if (!packageDir) return null;

  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  let pkg: PackageManifest | null = null;
  try {
    pkg = packageManifestSchema.parse(JSON.parse(readFileSync(packageJsonPath, "utf-8")));
  } catch {
    return null;
  }

  const declaredBin = pkg?.bin;
  if (!declaredBin) return null;

  const candidates = buildBinCandidates(packageName, binName);
  let chosenBinName: string | undefined;
  let binRel: string | undefined;

  if (declaredBin.kind === "single") {
    chosenBinName = defaultBinName(packageName);
    binRel = declaredBin.path;
  } else {
    const named = declaredBin.entries;
    for (const candidate of candidates) {
      if (named[candidate]) {
        chosenBinName = candidate;
        binRel = named[candidate];
        break;
      }
    }
    if (!binRel) {
      const firstEntry = Object.entries(named)[0];
      if (firstEntry) {
        chosenBinName = firstEntry[0];
        binRel = firstEntry[1];
      }
    }
  }

  if (!binRel) return null;

  const nodeModulesDir = findNodeModulesDir(packageDir);
  const binLink = chosenBinName ? join(nodeModulesDir, ".bin", chosenBinName) : null;
  let resolvedBin = binLink && existsSync(binLink) ? safeRealpath(binLink) : "";
  if (!resolvedBin) {
    resolvedBin = resolve(packageDir, binRel);
    if (!existsSync(resolvedBin)) return null;
  }

  const isJs = detectJsBinary(resolvedBin);
  return {
    resolvedBin,
    resolvedAt: Date.now(),
    packageVersion: pkg?.version,
    isJs,
  };
}

const FORCE_CACHE_TIMEOUT_MS = 30_000;

async function forceNpxCache(packageSpec: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "npm",
        ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"],
        { stdio: "ignore" }
      );
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("timeout"));
      }, FORCE_CACHE_TIMEOUT_MS);
      timer.unref();
      proc.on("close", () => { clearTimeout(timer); resolve(); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  } catch {
    // Ignore failures, resolution will fall back to original command
  }
}

function buildBinCandidates(packageName: string, explicitBin?: string): string[] {
  const candidates: string[] = [];
  if (explicitBin) candidates.push(explicitBin);

  if (packageName.startsWith("@")) {
    const namePart = packageName.split("/")[1] ?? "";
    const scopePart = packageName.split("/")[0]?.replace("@", "") ?? "";
    if (namePart) candidates.push(namePart);
    if (scopePart && namePart) candidates.push(`${scopePart}-${namePart}`);
  } else {
    candidates.push(packageName);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function extractPackageName(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex < 0) return null;
    const atIndex = trimmed.lastIndexOf("@");
    if (atIndex > slashIndex) {
      return trimmed.slice(0, atIndex);
    }
    return trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
}

function defaultBinName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const parts = packageName.split("/");
    return parts[1] ?? packageName.replace("@", "").replace("/", "-");
  }
  return packageName;
}

function findCachedPackageDir(cacheDir: string, packageName: string): string | null {
  const npxDir = join(cacheDir, "_npx");
  if (!existsSync(npxDir)) return null;

  const packagePathParts = packageName.startsWith("@")
    ? packageName.split("/")
    : [packageName];

  const candidates = readdirSync(npxDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const full = join(npxDir, entry.name);
      const mtime = safeStatMtime(full);
      return { name: entry.name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of candidates) {
    const pkgDir = join(npxDir, entry.name, "node_modules", ...packagePathParts);
    if (existsSync(join(pkgDir, "package.json"))) {
      return pkgDir;
    }
  }

  return null;
}

function findNodeModulesDir(packageDir: string): string {
  const parts = packageDir.split(sep);
  const idx = parts.lastIndexOf("node_modules");
  if (idx >= 0) {
    return parts.slice(0, idx + 1).join(sep);
  }
  return join(packageDir, "..");
}

function detectJsBinary(binPath: string): boolean {
  const ext = extname(binPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true;
  try {
    const fd = openSync(binPath, "r");
    try {
      const buf = Buffer.alloc(256);
      readSync(fd, buf, 0, 256, 0);
      const firstLine = buf.toString("utf-8").split("\n")[0] ?? "";
      return firstLine.startsWith("#!") && firstLine.includes("node");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

let npmCacheDirCached: string | null | undefined;

function getNpmCacheDir(): string | null {
  if (npmCacheDirCached !== undefined) return npmCacheDirCached;
  if (process.env.NPM_CONFIG_CACHE) {
    npmCacheDirCached = process.env.NPM_CONFIG_CACHE;
    return npmCacheDirCached;
  }
  try {
    const result = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf-8" });
    if (result.status === 0) {
      const path = String(result.stdout).trim();
      npmCacheDirCached = path || null;
      return npmCacheDirCached;
    }
  } catch {
    npmCacheDirCached = null;
    return null;
  }
  npmCacheDirCached = null;
  return null;
}

function getNpxCachePath(): string {
  return getAgentPath("mcp-npx-cache.json");
}

function loadCache(): NpxCache | null {
  const cachePath = getNpxCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const decoded = npxCacheSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf-8")));
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}

function saveCacheEntry(key: string, entry: NpxCacheEntry): void {
  const cachePath = getNpxCachePath();
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true });

  let merged: NpxCache = { version: CACHE_VERSION, entries: {} };
  try {
    if (existsSync(cachePath)) {
      const existing = npxCacheSchema.safeParse(JSON.parse(readFileSync(cachePath, "utf-8")));
      if (existing.success) {
        merged.entries = { ...existing.data.entries };
      }
    }
  } catch {
    // Ignore parse errors
  }

  merged.entries[key] = entry;
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, cachePath);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function safeStatMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
