import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { mentionsWorkflow } from "../eligibility.ts";
import { executeWorkflow, transformScript } from "../runtime.ts";
import type { SubagentRunner } from "../runtime.ts";
import { createRun, MAX_CONCURRENT_AGENTS } from "../runs.ts";
import { agentCacheKey } from "../persistence.ts";
import type { CachedAgentResult } from "../persistence.ts";
import { buildSubagentArgs, extractJson, runSubagent, SubagentProviderError, SubagentSchemaError } from "../subagent.ts";
import {
	deleteSavedWorkflow,
	discoverSavedWorkflows,
	parseSavedWorkflow,
	parseWorkflowArgs,
	savedWorkflowStatus,
	serializeSavedWorkflow,
	validateWorkflowName,
} from "../saved-workflows.ts";

let passed = 0;
const failures: string[] = [];
const execFileAsync = promisify(execFile);

async function temporaryGitRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-workflows-git-"));
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: root });
	await execFileAsync("git", ["config", "user.name", "Tests"], { cwd: root });
	await writeFile(join(root, "file.txt"), "original\n");
	await execFileAsync("git", ["add", "file.txt"], { cwd: root });
	await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
	return root;
}

async function test(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (error) {
		failures.push(name);
		console.error(`FAIL - ${name}\n  ${error instanceof Error ? error.stack : error}`);
	}
}

await test("workflow opt-in requires a standalone plural workflows mention in the current message", () => {
	assert.equal(mentionsWorkflow("Use a workflow to audit routes"), false);
	assert.equal(mentionsWorkflow("Run WORKFLOWS for this migration"), true);
	assert.equal(mentionsWorkflow("Could you use workflows?"), true);
	assert.equal(mentionsWorkflow("Audit every route in the repository"), false);
	assert.equal(mentionsWorkflow("Improve the workflowsEngine class"), false);
	assert.equal(mentionsWorkflow("Check @extensions/pi-workflows/PLAN.md"), false);
	assert.equal(mentionsWorkflow("Open extensions/workflows/PLAN.md"), false);
	assert.equal(mentionsWorkflow("This task was previously authorized"), false);
});

const mockRunner =
	(reply: (prompt: string) => string | Promise<string>): SubagentRunner =>
	async (request) => {
		const text = await reply(request.prompt);
		return {
			text,
			data: request.schema ? extractJson(text) : undefined,
			tokens: 100,
			cost: 0.001,
			turns: 1,
		};
	};

await test("transformScript strips export syntax", () => {
	const out = transformScript(`export const meta = { name: 'x' }\nexport default foo\nconst y = 1`);
	assert.equal(out, `const meta = { name: 'x' }\nfoo\nconst y = 1`);
});

await test("saved workflow metadata is parsed without executing source", () => {
	const source = `export const meta = { name: 'audit-routes', description: "Audit routes" }\nthrow new Error('must not run')`;
	const workflow = parseSavedWorkflow(source, "/tmp/audit.js", "personal");
	assert.equal(workflow.name, "audit-routes");
	assert.equal(workflow.description, "Audit routes");
	assert.equal(workflow.script, source);
});

await test("saved workflow metadata is validated", () => {
	assert.equal(validateWorkflowName("valid-command-2"), undefined);
	assert.match(validateWorkflowName("Invalid Name") ?? "", /kebab-case/);
	assert.match(validateWorkflowName("workflows") ?? "", /reserved/);
	assert.throws(() => parseSavedWorkflow(`export const meta = { name: 'Bad', description: 'x' }`, "bad.js", "project"));
});

await test("workflow arguments attempt JSON parsing then preserve raw text", () => {
	assert.equal(parseWorkflowArgs("   "), undefined);
	assert.deepEqual(parseWorkflowArgs(` {"root":"src"} `), { root: "src" });
	assert.deepEqual(parseWorkflowArgs("[1,2]"), [1, 2]);
	assert.equal(parseWorkflowArgs("42"), 42);
	assert.equal(parseWorkflowArgs("src routes"), "src routes");
	assert.equal(parseWorkflowArgs("  raw text  "), "  raw text  ");
});

await test("saved workflow serialization replaces existing metadata", () => {
	const serialized = serializeSavedWorkflow(
		"new-name",
		"New description",
		`export const meta = { name: 'old', description: 'Old' };\nconst result = await agent('x')\nreturn result`,
	);
	assert.equal((serialized.match(/export const meta/g) ?? []).length, 1);
	const parsed = parseSavedWorkflow(serialized, "new-name.js", "project");
	assert.equal(parsed.name, "new-name");
	assert.match(serialized, /const result = await agent/);
});

await test("discovery exposes effective and shadowed workflow files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workflows-discovery-"));
	const personal = join(root, "personal");
	const project = join(root, "project");
	await Promise.all([mkdir(personal), mkdir(project)]);
	const source = (name: string, description: string) =>
		`export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} };\nreturn 1`;
	await Promise.all([
		writeFile(join(personal, "audit.js"), source("audit", "personal audit")),
		writeFile(join(personal, "only.js"), source("only-personal", "only personal")),
		writeFile(join(project, "audit.js"), source("audit", "project audit")),
	]);
	const result = await discoverSavedWorkflows(personal, project, true);
	assert.equal(result.allWorkflows.length, 3);
	assert.equal(result.workflows.length, 2);
	assert.equal(result.workflows.find((item) => item.name === "audit")?.scope, "project");
	const active = new Set(result.workflows.map((item) => item.path));
	assert.equal(active.has(join(project, "audit.js")), true);
	assert.equal(active.has(join(personal, "audit.js")), false);
	const projectAudit = result.allWorkflows.find((item) => item.name === "audit" && item.scope === "project");
	const personalAudit = result.allWorkflows.find((item) => item.name === "audit" && item.scope === "personal");
	assert.ok(projectAudit && personalAudit);
	assert.equal(savedWorkflowStatus(projectAudit, result.workflows), "active");
	assert.equal(savedWorkflowStatus(personalAudit, result.workflows), "shadowed");
});

await test("bundled workflows are discovered and can be overridden", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workflows-bundled-"));
	const bundled = join(root, "bundled");
	const personal = join(root, "personal");
	const project = join(root, "project");
	await Promise.all([mkdir(bundled), mkdir(personal), mkdir(project)]);
	const source = (description: string) => `export const meta = { name: "deep-research", description: ${JSON.stringify(description)} };\nreturn 1`;
	await Promise.all([
		writeFile(join(bundled, "deep-research.js"), source("bundled")),
		writeFile(join(personal, "deep-research.js"), source("personal")),
		writeFile(join(project, "deep-research.js"), source("project")),
	]);
	const result = await discoverSavedWorkflows(personal, project, true, bundled);
	assert.equal(result.workflows[0]?.scope, "project");
	assert.deepEqual(result.allWorkflows.map((workflow) => workflow.scope), ["project", "personal", "bundled"]);
	const bundledWorkflow = result.allWorkflows.find((workflow) => workflow.scope === "bundled");
	assert.ok(bundledWorkflow);
	await assert.rejects(
		() => deleteSavedWorkflow(bundledWorkflow, { personalDirectory: personal, projectDirectory: project, projectTrusted: true }),
		/read-only/,
	);
});

await test("bundled deep-research workflow is valid and uses web tools without lean mode", async () => {
	const path = join(import.meta.dirname, "..", "workflows", "deep-research.js");
	const source = await readFile(path, "utf8");
	const workflow = parseSavedWorkflow(source, path, "bundled");
	assert.equal(workflow.name, "deep-research");
	assert.match(source, /"websearch", "webfetch"/);
	assert.doesNotMatch(source, /lean\s*:\s*true/);
	assert.match(source, /Math\.min\(10/);
});

await test("secure deletion deletes only the selected colliding workflow", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workflows-delete-"));
	const personal = join(root, "personal");
	const project = join(root, "project");
	await Promise.all([mkdir(personal), mkdir(project)]);
	const source = `export const meta = { name: "audit", description: "Audit" };\nreturn 1`;
	await Promise.all([writeFile(join(personal, "audit.js"), source), writeFile(join(project, "audit.js"), source)]);
	const result = await discoverSavedWorkflows(personal, project, true);
	const selected = result.allWorkflows.find((item) => item.scope === "project");
	assert.ok(selected);
	await deleteSavedWorkflow(selected, { personalDirectory: personal, projectDirectory: project, projectTrusted: true });
	assert.equal(await readFile(join(personal, "audit.js"), "utf8"), source);
	await assert.rejects(() => readFile(join(project, "audit.js"), "utf8"), /ENOENT/);
});

await test("secure deletion rejects missing, directory, non-js, symlink, outside, and untrusted project paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workflows-boundary-"));
	const personal = join(root, "personal");
	const project = join(root, "project");
	await Promise.all([mkdir(personal), mkdir(project)]);
	const workflow = (path: string, scope: "personal" | "project" = "personal") => ({
		name: "audit", description: "Audit", script: "return 1", path, scope,
	});
	const options = { personalDirectory: personal, projectDirectory: project, projectTrusted: true };
	await assert.rejects(() => deleteSavedWorkflow(workflow(join(personal, "missing.js")), options), /does not exist/);
	await mkdir(join(personal, "directory.js"));
	await assert.rejects(() => deleteSavedWorkflow(workflow(join(personal, "directory.js")), options), /regular file/);
	await writeFile(join(personal, "wrong.txt"), "x");
	await assert.rejects(() => deleteSavedWorkflow(workflow(join(personal, "wrong.txt")), options), /\.js file/);
	await writeFile(join(personal, "target.js"), "x");
	await symlink(join(personal, "target.js"), join(personal, "link.js"));
	await assert.rejects(() => deleteSavedWorkflow(workflow(join(personal, "link.js")), options), /symbolic link/);
	await writeFile(join(root, "outside.js"), "x");
	await assert.rejects(() => deleteSavedWorkflow(workflow(join(root, "outside.js")), options), /outside/);
	await writeFile(join(project, "audit.js"), "x");
	await assert.rejects(
		() => deleteSavedWorkflow(workflow(join(project, "audit.js"), "project"), { ...options, projectTrusted: false }),
		/untrusted project/,
	);
});

await test("extractJson handles bare, fenced, and embedded JSON", () => {
	assert.deepEqual(extractJson(`{"a":1}`), { a: 1 });
	assert.deepEqual(extractJson("Here you go:\n```json\n{\"a\": 2}\n```\ndone"), { a: 2 });
	assert.deepEqual(extractJson(`The answer is [1,2,3] as requested`), [1, 2, 3]);
	assert.throws(() => extractJson("no json here"));
});

await test("lean subagent arguments disable nonessential resources", () => {
	const signal = new AbortController().signal;
	const base = { prompt: "audit", cwd: "/repo", signal, provider: "p", model: "m" };
	const normal = buildSubagentArgs(base, "audit", ["read"]);
	const lean = buildSubagentArgs({ ...base, lean: true }, "audit", ["read"]);
	for (const flag of ["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]) {
		assert.equal(normal.includes(flag), false);
		assert.equal(lean.includes(flag), true);
	}
	assert.deepEqual(lean.slice(-7), ["--provider", "p", "--model", "m", "--thinking", "high", "audit"]);
	assert.deepEqual(buildSubagentArgs({ ...base, thinkingLevel: "low" }, "audit", ["read"]).slice(-3), ["--thinking", "low", "audit"]);
});

await test("runSubagent parses a final event without a trailing newline", async () => {
	const bin = await mkdtemp(join(tmpdir(), "pi-workflows-fakepi-"));
	const event = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "flushed" }], usage: { totalTokens: 5, cost: { total: 0 } } },
	});
	await writeFile(join(bin, "pi"), `#!/bin/sh\nprintf '%s' '${event}'\n`);
	await chmod(join(bin, "pi"), 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath}`;
	try {
		const result = await runSubagent({ prompt: "hello", cwd: bin, signal: new AbortController().signal });
		assert.equal(result.text, "flushed");
		assert.equal(result.tokens, 5);
	} finally {
		process.env.PATH = originalPath;
	}
});

await test("simple script returns agent text", async () => {
	const run = createRun("t1", "test", `const answer = await agent('What is 2+2?')\nreturn answer`);
	const result = await executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: mockRunner(() => "4"),
	});
	assert.equal(result, "4");
	assert.equal(run.agents.length, 1);
	assert.equal(run.agents[0]?.status, "done");
});

await test("agent cache keys are stable but include execution-affecting options", () => {
	const first = agentCacheKey("audit", { schema: { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } } }, { cwd: "/repo", model: "m", provider: "p" });
	const reordered = agentCacheKey("audit", { schema: { properties: { a: { type: "number" }, b: { type: "string" } }, type: "object" } }, { cwd: "/repo", model: "m", provider: "p" });
	assert.equal(first, reordered);
	assert.notEqual(first, agentCacheKey("audit changed", {}, { cwd: "/repo", model: "m", provider: "p" }));
	const normal = agentCacheKey("audit", {}, { cwd: "/repo", model: "m", provider: "p" });
	assert.equal(normal, agentCacheKey("audit", { lean: false }, { cwd: "/repo", model: "m", provider: "p" }));
	assert.notEqual(normal, agentCacheKey("audit", { lean: true }, { cwd: "/repo", model: "m", provider: "p" }));
	assert.equal(normal, agentCacheKey("audit", { thinkingLevel: "high" }, { cwd: "/repo", model: "m", provider: "p" }));
	assert.notEqual(normal, agentCacheKey("audit", { thinkingLevel: "low" }, { cwd: "/repo", model: "m", provider: "p" }));
});

await test("thinking level defaults to high and supports per-agent overrides", async () => {
	const levels: Array<string | undefined> = [];
	const run = createRun("thinking", "test", `
		await agent('default')
		return agent('override', { thinkingLevel: 'max' })
	`);
	await executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: async (request) => {
			levels.push(request.thinkingLevel);
			return { text: "ok", tokens: 1, cost: 0, turns: 1 };
		},
	});
	assert.deepEqual(levels, ["high", "max"]);
});

await test("lean option reaches the subagent runner and run record", async () => {
	let lean: boolean | undefined;
	const run = createRun("lean", "test", `return agent('audit', { lean: true })`);
	await executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: async (request) => {
			lean = request.lean;
			return { text: "ok", tokens: 1, cost: 0, turns: 1 };
		},
	});
	assert.equal(lean, true);
	assert.equal(run.agents[0]?.lean, true);
});

await test("completed agent cache skips subagent execution and restores schema values", async () => {
	const cache = new Map<string, CachedAgentResult>();
	const script = `return await agent('cached prompt', { schema: { type: 'object' } })`;
	const first = createRun("cache-first", "test", script);
	await executeWorkflow(first, {
		cwd: process.cwd(),
		cache: { get: (key) => cache.get(key), put: (key, value) => cache.set(key, value) },
		runAgent: mockRunner(() => `{"ok":true}`),
	});
	let calls = 0;
	const second = createRun("cache-second", "test", script);
	const result = await executeWorkflow(second, {
		cwd: process.cwd(),
		cache: { get: (key) => cache.get(key), put: (key, value) => cache.set(key, value) },
		runAgent: async () => { calls++; throw new Error("must not execute"); },
	});
	assert.deepEqual(result, { ok: true });
	assert.equal(calls, 0);
	assert.equal(second.agents[0]?.cached, true);
});

await test("schema option returns parsed data", async () => {
	const run = createRun(
		"t2",
		"test",
		`const found = await agent('list files', { schema: { type: 'object' } })\nreturn found.files.length`,
	);
	const result = await executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: mockRunner(() => `{"files": ["a.ts", "b.ts"]}`),
	});
	assert.equal(result, 2);
});

await test("invalid schema output is corrected once", async () => {
	let attempts = 0;
	let repairPrompt = "";
	const run = createRun("schema-retry", "test", `return await agent('find files', { schema: { type: 'object' } })`);
	const result = await executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: async (request) => {
			attempts++;
			if (attempts === 1) throw new SubagentSchemaError("Unexpected token", "not json");
			repairPrompt = request.prompt;
			return { text: `{"files":[]}`, data: { files: [] }, tokens: 1, cost: 0, turns: 1 };
		},
	});
	assert.deepEqual(result, { files: [] });
	assert.equal(attempts, 2);
	assert.match(repairPrompt, /Unexpected token/);
	assert.match(repairPrompt, /not json/);
	assert.equal(run.agents.length, 1);
	assert.equal(run.agents[0]?.attempts, 2);
});

await test("schema correction is attempted only once", async () => {
	let attempts = 0;
	const run = createRun("schema-fail", "test", `return await agent('x', { schema: { type: 'object' } })`);
	await assert.rejects(() => executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: async () => {
			attempts++;
			throw new SubagentSchemaError("bad json", "bad");
		},
	}), /bad json/);
	assert.equal(attempts, 2);
});

await test("transient provider failures retry once", async () => {
	let attempts = 0;
	const run = createRun("provider-retry", "test", `return await agent('x')`);
	const result = await executeWorkflow(run, {
		cwd: process.cwd(),
		retryDelayMs: 0,
		runAgent: async () => {
			attempts++;
			if (attempts === 1) throw new SubagentProviderError("429 rate limit", true);
			return { text: "ok", tokens: 1, cost: 0, turns: 1 };
		},
	});
	assert.equal(result, "ok");
	assert.equal(attempts, 2);
	assert.equal(run.agents.length, 1);
	assert.equal(run.agents[0]?.attempts, 2);
});

await test("restarting a failed agent re-runs it and logs the resume hint", async () => {
	let calls = 0;
	const run = createRun("restart", "test", `return await agent('x')`);
	await assert.rejects(() => executeWorkflow(run, {
		cwd: process.cwd(),
		retryDelayMs: 0,
		runAgent: async () => {
			calls++;
			if (calls === 1) throw new SubagentProviderError("invalid API key", false);
			return { text: "recovered", tokens: 1, cost: 0, turns: 1 };
		},
	}), /invalid API key/);
	assert.equal(run.agents[0]?.status, "error");
	await run.agents[0]?.restart?.();
	assert.equal(run.agents.length, 2);
	assert.equal(run.agents[1]?.status, "done");
	assert.equal(run.agents[1]?.output, "recovered");
	assert.match(run.logs[run.logs.length - 1] ?? "", /re-run succeeded; resume the run/);
});

await test("permanent provider failures do not retry", async () => {
	let attempts = 0;
	const run = createRun("provider-fail", "test", `return await agent('x')`);
	await assert.rejects(() => executeWorkflow(run, {
		cwd: process.cwd(),
		retryDelayMs: 0,
		runAgent: async () => {
			attempts++;
			throw new SubagentProviderError("invalid API key", false);
		},
	}), /invalid API key/);
	assert.equal(attempts, 1);
});

await test("isolated agents capture changes without touching the original checkout", async () => {
	const root = await temporaryGitRepository();
	let isolatedCwd = "";
	const run = createRun("isolated", "test", `return await agent('edit', { isolated: true, tools: ['read', 'edit'] })`);
	const result = await executeWorkflow(run, {
		cwd: root,
		runAgent: async (request) => {
			isolatedCwd = request.cwd;
			await writeFile(join(request.cwd, "file.txt"), "changed\n");
			await writeFile(join(request.cwd, "new.txt"), "new\n");
			return { text: "done", tokens: 1, cost: 0, turns: 1 };
		},
	}) as { output: string; diff: string; changedFiles: string[] };
	assert.equal(result.output, "done");
	assert.deepEqual(result.changedFiles.sort(), ["file.txt", "new.txt"]);
	assert.match(result.diff, /changed/);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "original\n");
	await assert.rejects(() => readFile(isolatedCwd, "utf8"), /ENOENT|EISDIR/);
	assert.equal(run.agents[0]?.isolated, true);
	assert.deepEqual(run.agents[0]?.changedFiles?.sort(), ["file.txt", "new.txt"]);
});

await test("apply() applies an isolated agent patch to the original checkout", async () => {
	const root = await temporaryGitRepository();
	const run = createRun("apply-isolated", "test", `const change = await agent('edit', { isolated: true })\nawait apply(change.diff)\nreturn change.output`);
	const result = await executeWorkflow(run, {
		cwd: root,
		runAgent: async (request) => {
			await writeFile(join(request.cwd, "file.txt"), "applied\n");
			return { text: "applied it", tokens: 1, cost: 0, turns: 1 };
		},
	});
	assert.equal(result, "applied it");
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "applied\n");
});

await test("concurrent apply() calls are serialized instead of colliding on the git index", async () => {
	const root = await temporaryGitRepository();
	const run = createRun(
		"apply-concurrent",
		"test",
		`const changes = await pipeline(['a', 'b', 'c', 'd'], (name) => agent('edit ' + name, { isolated: true }))
		await Promise.all(changes.map((change) => apply(change.diff)))
		return changes.length`,
	);
	const result = await executeWorkflow(run, {
		cwd: root,
		runAgent: async (request) => {
			const name = request.prompt.split(" ").pop();
			await writeFile(join(request.cwd, `${name}.txt`), `${name}\n`);
			return { text: "done", tokens: 1, cost: 0, turns: 1 };
		},
	});
	assert.equal(result, 4);
	for (const name of ["a", "b", "c", "d"]) {
		assert.equal(await readFile(join(root, `${name}.txt`), "utf8"), `${name}\n`);
	}
});

await test("isolated and schema options cannot be combined", async () => {
	const root = await temporaryGitRepository();
	const run = createRun("bad-isolated", "test", `return agent('x', { isolated: true, schema: { type: 'object' } })`);
	await assert.rejects(() => executeWorkflow(run, { cwd: root, runAgent: mockRunner(() => "{}") }), /cannot combine/);
});

await test("pipeline runs all items and nulls out failures", async () => {
	const run = createRun(
		"t3",
		"test",
		`const results = await pipeline(['a', 'b', 'c'], (item) => agent('check ' + item, { label: item }))\nreturn results`,
	);
	const result = await executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: mockRunner((prompt) => {
			if (prompt.includes("b")) throw new Error("boom");
			return `done: ${prompt}`;
		}),
	});
	assert.deepEqual(result, ["done: check a", null, "done: check c"]);
	assert.equal(run.agents.filter((agent) => agent.status === "error").length, 1);
	assert.equal(run.logs.length, 1);
	assert.match(run.logs[0] ?? "", /item 2 failed: boom/);
});

await test("concurrency never exceeds the cap", async () => {
	let current = 0;
	let peak = 0;
	const run = createRun(
		"t4",
		"test",
		`return await pipeline(Array.from({length: 30}, (_, i) => i), (i) => agent('item ' + i))`,
	);
	const result = (await executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: async (request) => {
			current++;
			peak = Math.max(peak, current);
			await new Promise((resolve) => setTimeout(resolve, 5));
			current--;
			return { text: request.prompt, tokens: 1, cost: 0, turns: 1 };
		},
	})) as unknown[];
	assert.equal(result.length, 30);
	assert.ok(peak <= MAX_CONCURRENT_AGENTS, `peak concurrency ${peak} exceeded cap`);
	assert.ok(peak > 1, "expected some parallelism");
});

await test("script syntax errors are reported clearly", async () => {
	const run = createRun("t5", "test", `const = broken`);
	await assert.rejects(
		() => executeWorkflow(run, { cwd: process.cwd(), runAgent: mockRunner(() => "x") }),
		/syntax error/,
	);
});

await test("abort stops pending agents", async () => {
	const run = createRun(
		"t6",
		"test",
		`return await pipeline([1, 2, 3, 4], (i) => agent('item ' + i))`,
	);
	const promise = executeWorkflow(run, {
		cwd: process.cwd(),
		runAgent: async (request) => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			if (request.signal.aborted) throw new Error("Workflow aborted");
			return { text: "ok", tokens: 1, cost: 0, turns: 1 };
		},
	});
	setTimeout(() => run.abortController.abort(), 10);
	await assert.rejects(promise, /aborted/i);
});

await test("log() and args are wired through", async () => {
	const run = createRun("t7", "test", `log('starting on ' + args.target)\nreturn args.target`);
	const result = await executeWorkflow(run, {
		cwd: process.cwd(),
		args: { target: "src/" },
		runAgent: mockRunner(() => "unused"),
	});
	assert.equal(result, "src/");
	assert.deepEqual(run.logs, ["starting on src/"]);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
