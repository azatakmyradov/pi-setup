import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

interface CommandResult {
	stdout: string;
	stderr: string;
}

function runCommand(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; input?: string }): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) return reject(new Error("Workflow aborted"));
		const child = spawn(command, args, { cwd: options.cwd, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		const onAbort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", finishError);
		child.on("close", (code, signal) => {
			if (options.signal?.aborted) return finishError(new Error("Workflow aborted"));
			const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
			if (code === 0) return finish(() => resolve(result));
			finishError(new Error(`${command} ${args.join(" ")} failed (${signal ?? code}): ${result.stderr.trim() || result.stdout.trim()}`));
		});
		if (options.input !== undefined) child.stdin!.end(options.input);

		function finish(fn: () => void) {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		}
		function finishError(error: Error) {
			finish(() => reject(error));
		}
	});
}

export interface RepositoryContext {
	root: string;
	prefix: string;
}

export interface WorktreeChanges {
	diff: string;
	changedFiles: string[];
}

export interface TemporaryWorktree {
	path: string;
	cwd: string;
	captureChanges(): Promise<WorktreeChanges>;
	cleanup(): Promise<void>;
}

export async function findRepository(cwd: string, signal?: AbortSignal): Promise<RepositoryContext> {
	let root: string;
	try {
		root = (await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, signal })).stdout.trim();
		await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, signal });
	} catch (error) {
		throw new Error(`Worktree isolation requires a Git repository with at least one commit: ${error instanceof Error ? error.message : String(error)}`);
	}
	const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)]);
	return { root: canonicalRoot, prefix: relative(canonicalRoot, canonicalCwd) };
}

export async function createTemporaryWorktree(cwd: string, signal?: AbortSignal): Promise<TemporaryWorktree> {
	const repository = await findRepository(cwd, signal);
	const parent = await mkdtemp(join(tmpdir(), "pi-workflow-worktree-"));
	const path = join(parent, "checkout");
	let added = false;
	try {
		await runCommand("git", ["worktree", "add", "--detach", path, "HEAD"], { cwd: repository.root, signal });
		added = true;
	} catch (error) {
		await rm(parent, { recursive: true, force: true });
		throw error;
	}

	let cleaned = false;
	return {
		path,
		cwd: join(path, repository.prefix),
		async captureChanges() {
			await runCommand("git", ["add", "-N", "--all"], { cwd: path, signal });
			const [patch, names] = await Promise.all([
				runCommand("git", ["diff", "--binary", "HEAD"], { cwd: path, signal }),
				runCommand("git", ["diff", "--name-only", "-z", "HEAD"], { cwd: path, signal }),
			]);
			return {
				diff: patch.stdout,
				changedFiles: names.stdout.split("\0").filter(Boolean),
			};
		},
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			try {
				if (added) await runCommand("git", ["worktree", "remove", "--force", path], { cwd: repository.root });
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	};
}

export async function applyWorktreePatch(cwd: string, patch: string, signal?: AbortSignal): Promise<void> {
	if (typeof patch !== "string" || !patch.trim()) throw new Error("apply(diff) requires a non-empty Git patch");
	const repository = await findRepository(cwd, signal);
	try {
		await runCommand("git", ["apply", "--3way", "--index", "-"], { cwd: repository.root, signal, input: patch });
	} catch (error) {
		throw new Error(`Could not apply isolated-agent patch: ${error instanceof Error ? error.message : String(error)}`);
	}
}
