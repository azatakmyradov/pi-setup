/**
 * Named agent definitions.
 *
 * An agent definition is a reusable spawn preset: a name the parent model can
 * pass to `subagent_spawn` instead of restating harness, model, tool set, and
 * child preamble every time. Two built-ins ship with the extension; users add
 * their own as markdown files with YAML frontmatter, globally in
 * `<agentDir>/agents/*.md` and per project in `<cwd>/.pi/agents/*.md`.
 *
 * Loading fails soft: one malformed file is skipped with a warning so a typo in
 * a definition can never keep the tool from registering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { BackendName, ReasoningEffort } from "./domain.ts";
import { BACKEND_NAMES, REASONING_EFFORTS } from "./domain.ts";
import { boundedError } from "./json.ts";

/** One spawn preset. `prompt` is appended to the child's system prompt. */
export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  /** Child preamble, mapped to each harness's append-system-prompt hook. */
  readonly prompt?: string;
  readonly harness?: BackendName;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  /** Tool allowlist; the caller cannot widen it. */
  readonly tools?: ReadonlyArray<string>;
  /** Kept out of the roster, still spawnable by name. */
  readonly hidden?: boolean;
}

/** Definitions by name, in roster order (built-ins first). */
export type AgentDefinitions = ReadonlyMap<string, AgentDefinition>;

/** Assembly view of a definition: optional fields stay absent when unset. */
type AgentDefinitionDraft = {
  -readonly [K in keyof AgentDefinition]: AgentDefinition[K];
};

export const DEFAULT_AGENT_NAME = "general";

const GENERAL_AGENT: AgentDefinition = {
  name: DEFAULT_AGENT_NAME,
  description:
    "General-purpose autonomous agent with the harness's full tool set and no extra instructions. The default when no agent is named.",
};

/**
 * Read-only search specialist. The tool set mirrors the one the review
 * extension already gives its pi child, so a shell is available for `rg` and
 * friends while the prompt is what keeps the child from mutating anything.
 */
const EXPLORE_PROMPT = `You are a read-only file-search specialist. You locate code, configuration, and documentation, then report exactly what you found. You never change anything.

Report protocol:
- Always give absolute paths, with line numbers when a specific definition matters.
- Quote only the few lines that carry the answer; never paste whole files.
- Say plainly what you could not find, and where you already looked.
- End with a short conclusion that answers the question you were asked.

Thoroughness protocol. The caller may ask for a level; default to medium.
- quick: one or two targeted searches in the obvious location, then answer.
- medium: cover the likely directories and the common naming variants (camelCase, snake_case, kebab-case, abbreviations) before answering.
- very thorough: sweep the whole tree, follow imports and re-exports, check tests, fixtures, configuration, and generated code, and enumerate every match.

Hard limits: never create, edit, move, or delete a file, and never run a state-changing command. Use the shell for read-only inspection only (for example rg, grep, sed -n, find, ls, git log, git show). Never run installers, builds, formatters, writing git commands, or anything that touches the network.`;

const EXPLORE_AGENT: AgentDefinition = {
  name: "explore",
  description:
    "Read-only file-search specialist: finds code and reports absolute paths and line numbers. Cannot edit files. Say how thorough to be (quick, medium, very thorough).",
  prompt: EXPLORE_PROMPT,
  tools: ["read", "grep", "find", "ls", "bash"],
};

export const BUILT_IN_AGENTS: ReadonlyArray<AgentDefinition> = [GENERAL_AGENT, EXPLORE_AGENT];

// --- Loading ------------------------------------------------------------------

/** File-name-safe agent names keep the tool's `agent` argument unambiguous. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Frontmatter fields. Unknown keys are ignored so a definition written for a
 * newer version of this extension still loads.
 */
const frontmatterSchema = z.object({
  description: z.string().trim().min(1).optional(),
  harness: z.enum(BACKEND_NAMES).optional(),
  model: z.string().trim().min(1).optional(),
  reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
  tools: z.array(z.string().trim().min(1)).optional(),
  hidden: z.boolean().optional(),
  disable: z.boolean().optional(),
});

export interface LoadAgentDefinitionsOptions {
  /** Global pi agent directory (`getAgentDir()`). */
  readonly agentDir: string;
  readonly cwd: string;
  /** Project definitions load only for a trusted project. */
  readonly projectTrusted: boolean;
}

export interface LoadedAgentDefinitions {
  readonly agents: AgentDefinitions;
  /** One line per skipped file; the caller surfaces them. */
  readonly warnings: ReadonlyArray<string>;
}

type AgentFileFields = z.output<typeof frontmatterSchema>;

/** A filesystem failure's code, read without trusting the thrown value. */
const errnoSchema = z.object({ code: z.string() });

const WARNING_MAX_LENGTH = 200;

/** Markdown files in `directory`, sorted; a missing directory yields none. */
function agentFiles(directory: string, warnings: string[]): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md"))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    const errno = errnoSchema.safeParse(error);
    const missing =
      errno.success && (errno.data.code === "ENOENT" || errno.data.code === "ENOTDIR");
    if (!missing) {
      warnings.push(
        `${directory}: unreadable agent directory (${boundedError(error, WARNING_MAX_LENGTH)})`,
      );
    }
    return [];
  }
}

/** Validated fields plus the markdown body, or undefined with a warning. */
function readAgentFile(file: string, warnings: string[]) {
  let frontmatter: unknown;
  let body: string;
  try {
    const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (error) {
    warnings.push(
      `${file}: could not read agent definition (${boundedError(error, WARNING_MAX_LENGTH)})`,
    );
    return undefined;
  }

  const fields = frontmatterSchema.safeParse(frontmatter);
  if (!fields.success) {
    const issues = fields.error.issues
      .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
      .join("; ");
    warnings.push(`${file}: invalid frontmatter (${issues})`);
    return undefined;
  }
  return { fields: fields.data, body };
}

/** Build one definition from its validated frontmatter and body. */
function toDefinition(name: string, fields: AgentFileFields, body: string, description: string) {
  const definition: AgentDefinitionDraft = { name, description };
  const prompt = body.trim();
  if (prompt) definition.prompt = prompt;
  if (fields.harness) definition.harness = fields.harness;
  if (fields.model) definition.model = fields.model;
  if (fields.reasoning_effort) definition.reasoningEffort = fields.reasoning_effort;
  const tools = fields.tools ? [...new Set(fields.tools)] : [];
  if (tools.length > 0) definition.tools = tools;
  if (fields.hidden === true) definition.hidden = true;
  return definition;
}

/** Apply one definition file, or record why it was skipped. */
function applyAgentFile(
  file: string,
  agents: Map<string, AgentDefinition>,
  warnings: string[],
): void {
  const name = path.basename(file, ".md");
  if (!AGENT_NAME_PATTERN.test(name)) {
    warnings.push(`${file}: agent file names must match ${AGENT_NAME_PATTERN.source}`);
    return;
  }

  const parsed = readAgentFile(file, warnings);
  if (!parsed) return;

  if (parsed.fields.disable === true) {
    agents.delete(name);
    return;
  }

  const description = parsed.fields.description;
  if (!description) {
    warnings.push(`${file}: missing required frontmatter field "description"`);
    return;
  }

  agents.set(name, toDefinition(name, parsed.fields, parsed.body, description));
}

/**
 * Built-ins, then global definitions, then project definitions. A later source
 * overrides an earlier one by name (keeping its roster position), and
 * `disable: true` removes the name entirely.
 */
export function loadAgentDefinitions(options: LoadAgentDefinitionsOptions): LoadedAgentDefinitions {
  const agents = new Map<string, AgentDefinition>();
  for (const agent of BUILT_IN_AGENTS) agents.set(agent.name, agent);

  const warnings: string[] = [];
  const directories = [path.join(options.agentDir, "agents")];
  if (options.projectTrusted) directories.push(path.join(options.cwd, ".pi", "agents"));
  for (const directory of directories) {
    for (const file of agentFiles(directory, warnings)) {
      applyAgentFile(file, agents, warnings);
    }
  }
  return { agents, warnings };
}

// --- Model-facing views --------------------------------------------------------

/** The roster appended to the spawn tool description. Hidden agents are omitted. */
export function buildAgentRoster(agents: AgentDefinitions): string {
  const lines = [...agents.values()]
    .filter((agent) => !agent.hidden)
    .map((agent) => `- ${agent.name}: ${agent.description}`);
  return lines.length === 0 ? "" : `Available agents:\n${lines.join("\n")}`;
}

/** Resolve a caller-supplied agent name, defaulting to `general`. */
export function resolveSpawnAgent(
  agents: AgentDefinitions,
  name: string | undefined,
): AgentDefinition {
  const requested = name?.trim() || DEFAULT_AGENT_NAME;
  const found = agents.get(requested);
  if (found) return found;
  const known = [...agents.keys()].join(", ") || "none";
  throw new Error(`Unknown agent "${requested}". Known agents: ${known}.`);
}
