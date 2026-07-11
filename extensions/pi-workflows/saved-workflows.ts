import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

export type WorkflowScope = "bundled" | "personal" | "project";

export interface SavedWorkflow {
	name: string;
	description: string;
	script: string;
	path: string;
	scope: WorkflowScope;
}

export interface WorkflowDiagnostic {
	path: string;
	message: string;
}

export interface DiscoverSavedWorkflowsResult {
	workflows: SavedWorkflow[];
	allWorkflows: SavedWorkflow[];
	diagnostics: WorkflowDiagnostic[];
}

export interface DeleteSavedWorkflowOptions {
	personalDirectory: string;
	projectDirectory: string;
	projectTrusted: boolean;
}

const COMMAND_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const META_START = /\bexport\s+const\s+meta\s*=\s*\{/g;

export function validateWorkflowName(name: string): string | undefined {
	if (!COMMAND_NAME.test(name)) return "must be kebab-case using lowercase letters, numbers, and hyphens";
	if (name === "workflows") return '"workflows" is reserved';
	return undefined;
}

function findMetaBlock(source: string): { start: number; end: number; body: string } {
	META_START.lastIndex = 0;
	const match = META_START.exec(source);
	if (!match) throw new Error("missing `export const meta = { ... }`");
	const open = source.indexOf("{", match.index);
	let quote = "";
	let escaped = false;
	for (let index = open + 1; index < source.length; index++) {
		const char = source[index] ?? "";
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "}") {
			let end = index + 1;
			while (/\s/.test(source[end] ?? "")) end++;
			if (source[end] === ";") end++;
			return { start: match.index, end, body: source.slice(open + 1, index) };
		} else if (char === "{") throw new Error("meta values must be plain strings");
	}
	throw new Error("unterminated meta object");
}

function readStringProperty(body: string, property: string): string {
	const pattern = new RegExp(
		String.raw`(?:^|[,\n])\s*(?:${property}|"${property}"|'${property}')\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`,
		"m",
	);
	const match = body.match(pattern);
	if (!match?.[1]) throw new Error(`meta.${property} must be a string`);
	const token = match[1];
	if (token.startsWith('"')) return JSON.parse(token) as string;
	return token
		.slice(1, -1)
		.replace(/\\(['"\\bfnrt])/g, (_all, escaped: string) => {
			const values: Record<string, string> = { "'": "'", '"': '"', "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
			return values[escaped] ?? escaped;
		})
		.replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export function parseSavedWorkflow(source: string, path: string, scope: WorkflowScope): SavedWorkflow {
	const block = findMetaBlock(source);
	const name = readStringProperty(block.body, "name").trim();
	const description = readStringProperty(block.body, "description").trim();
	const nameError = validateWorkflowName(name);
	if (nameError) throw new Error(`invalid meta.name: ${nameError}`);
	if (!description) throw new Error("meta.description must not be empty");
	return { name, description, script: source, path, scope };
}

async function scanDirectory(directory: string, scope: WorkflowScope): Promise<DiscoverSavedWorkflowsResult> {
	const workflows: SavedWorkflow[] = [];
	const diagnostics: WorkflowDiagnostic[] = [];
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workflows, allWorkflows: workflows, diagnostics };
		diagnostics.push({ path: directory, message: error instanceof Error ? error.message : String(error) });
		return { workflows, allWorkflows: workflows, diagnostics };
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const path = join(directory, entry.name);
		try {
			workflows.push(parseSavedWorkflow(await readFile(path, "utf8"), path, scope));
		} catch (error) {
			diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { workflows, allWorkflows: workflows, diagnostics };
}

export async function discoverSavedWorkflows(
	personalDirectory: string,
	projectDirectory: string,
	projectTrusted: boolean,
	bundledDirectory?: string,
): Promise<DiscoverSavedWorkflowsResult> {
	const empty = { workflows: [], allWorkflows: [], diagnostics: [] };
	const bundled = bundledDirectory ? await scanDirectory(bundledDirectory, "bundled") : empty;
	const personal = await scanDirectory(personalDirectory, "personal");
	const project = projectTrusted ? await scanDirectory(projectDirectory, "project") : empty;
	const merged = new Map<string, SavedWorkflow>();
	const diagnostics = [...bundled.diagnostics, ...personal.diagnostics, ...project.diagnostics];
	for (const workflow of [...bundled.workflows, ...personal.workflows, ...project.workflows]) {
		const existing = merged.get(workflow.name);
		if (existing?.scope === workflow.scope) {
			diagnostics.push({ path: workflow.path, message: `duplicate command /${workflow.name}; ${basename(workflow.path)} wins` });
		}
		merged.set(workflow.name, workflow);
	}
	const rank: Record<WorkflowScope, number> = { project: 0, personal: 1, bundled: 2 };
	const allWorkflows = [...bundled.workflows, ...personal.workflows, ...project.workflows].sort(
		(a, b) => a.name.localeCompare(b.name) || rank[a.scope] - rank[b.scope] || a.path.localeCompare(b.path),
	);
	return { workflows: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), allWorkflows, diagnostics };
}

export function savedWorkflowStatus(
	workflow: SavedWorkflow,
	effectiveWorkflows: readonly SavedWorkflow[],
): "active" | "shadowed" {
	return effectiveWorkflows.some((effective) => effective.path === workflow.path) ? "active" : "shadowed";
}

export async function deleteSavedWorkflow(
	workflow: SavedWorkflow,
	options: DeleteSavedWorkflowOptions,
): Promise<void> {
	if (workflow.scope === "bundled") throw new Error("Bundled workflows are read-only");
	if (workflow.scope === "project" && !options.projectTrusted) {
		throw new Error("Cannot delete a project workflow from an untrusted project");
	}
	if (extname(workflow.path) !== ".js") throw new Error("Saved workflow deletion requires a .js file");

	const expectedDirectory = resolve(
		workflow.scope === "personal" ? options.personalDirectory : options.projectDirectory,
	);
	let info;
	try {
		info = await lstat(workflow.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Saved workflow file does not exist: ${workflow.path}`);
		}
		throw error;
	}
	if (info.isSymbolicLink()) throw new Error("Refusing to delete a symbolic link");
	if (!info.isFile()) throw new Error("Saved workflow path is not a regular file");

	let canonicalDirectory: string;
	let canonicalTarget: string;
	try {
		[canonicalDirectory, canonicalTarget] = await Promise.all([realpath(expectedDirectory), realpath(workflow.path)]);
	} catch (error) {
		throw new Error(`Unable to canonicalize saved workflow path: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (dirname(canonicalTarget) !== canonicalDirectory) {
		throw new Error(`Refusing to delete a file outside ${canonicalDirectory}`);
	}
	await unlink(canonicalTarget);
}

export function parseWorkflowArgs(raw: string): unknown {
	const value = raw.trim();
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return raw;
	}
}

export function serializeSavedWorkflow(name: string, description: string, script: string): string {
	let body = script;
	try {
		const block = findMetaBlock(script);
		body = `${script.slice(0, block.start)}${script.slice(block.end)}`.trimStart();
	} catch {}
	return `export const meta = ${JSON.stringify({ name, description }, null, "\t")};\n\n${body.trimEnd()}\n`;
}

export async function saveWorkflowFile(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
