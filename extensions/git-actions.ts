import { spawn } from "node:child_process";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runSubagent } from "./lib/subagent";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";

type Action = "commit" | "new-branch" | "pr";
type Generated =
  | { message: string }
  | { name: string }
  | { title: string; body: string; base: string };

const schemas: Record<Action, Record<string, unknown>> = {
  commit: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  "new-branch": {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  pr: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      base: { type: "string" },
    },
    required: ["title", "body", "base"],
    additionalProperties: false,
  },
};

const instructions: Record<Action, (args: string) => string> = {
  commit: (args) => `Inspect the Git status, relevant diff, and recent commit style. Generate only a concise commit message matching the repository convention. Do not modify files, stage changes, commit, or run validation. ${args ? `User instructions: ${args}` : ""}`,
  "new-branch": (args) => `Inspect the current work and existing branch naming conventions. Generate only a safe, concise branch name. Do not create or switch branches and do not modify the repository. ${args ? `Use this name or description: ${args}` : "Use kebab-case and the customary prefix when evident."}`,
  pr: (args) => `Inspect the current branch, default base branch, commits and diff against the base, and any PR template. Generate only the pull-request title, body, and base branch. Do not push, create a PR, modify files, or run validation. ${args ? `User instructions: ${args}` : "Include a concise summary and test status in the body."}`,
};

function command(program: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return reject(new Error("Git action aborted"));
      if (code !== 0) return reject(new Error(stderr.trim() || `${program} exited with code ${code}`));
      resolve(stdout.trim());
    });
  });
}

function value(data: unknown, key: string): string {
  if (!data || typeof data !== "object") throw new Error("Generator returned invalid data");
  const result = (data as Record<string, unknown>)[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`Generator returned an invalid ${key}`);
  return result.trim();
}

async function apply(
  action: Action,
  generated: Generated,
  cwd: string,
  signal: AbortSignal,
  stageAll = false,
): Promise<string> {
  if (action === "commit") {
    const message = value(generated, "message");
    if (stageAll) await command("git", ["add", "-A"], cwd, signal);
    await command("git", ["commit", "-m", message], cwd, signal);
    const hash = await command("git", ["rev-parse", "--short", "HEAD"], cwd, signal);
    return `Committed ${hash}: ${message}`;
  }

  if (action === "new-branch") {
    const name = value(generated, "name");
    await command("git", ["check-ref-format", "--branch", name], cwd, signal);
    await command("git", ["switch", "-c", name], cwd, signal);
    return `Created and switched to ${name}`;
  }

  const title = value(generated, "title");
  const body = value(generated, "body");
  const base = value(generated, "base");
  const branch = await command("git", ["branch", "--show-current"], cwd, signal);
  if (!branch) throw new Error("Cannot create a PR from a detached HEAD");

  try {
    const existing = await command("gh", ["pr", "view", "--json", "url", "--jq", ".url"], cwd, signal);
    if (existing) return `Pull request already exists: ${existing}`;
  } catch {
    // No PR exists for this branch yet.
  }

  await command("git", ["push", "--set-upstream", "origin", branch], cwd, signal);
  const url = await command("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body], cwd, signal);
  return `Created pull request: ${url}`;
}

export default function (pi: ExtensionAPI) {
  let actionRunning = false;
  let actionController: AbortController | undefined;

  async function run(action: Action, args: string, ctx: ExtensionCommandContext) {
    if (actionRunning) {
      ctx.ui.notify("A Git action is already running.", "warning");
      return;
    }

    if (!ctx.modelRegistry.find(PROVIDER, MODEL_ID)) {
      ctx.ui.notify(`${PROVIDER}/${MODEL_ID} is unavailable.`, "error");
      return;
    }

    actionRunning = true;
    actionController = new AbortController();
    try {
      if (action === "pr") {
        const currentBranch = await command("git", ["branch", "--show-current"], ctx.cwd, actionController.signal);
        if (!currentBranch) throw new Error("Cannot create a pull request from a detached HEAD. Switch to a branch first.");
        if (currentBranch === "main") throw new Error("Cannot create a pull request from main. Create or switch to a feature branch first.");
      }

      const generate = async (target: Action, userArgs: string, extraInstructions = ""): Promise<Generated> => {
        let prompt = instructions[target](userArgs);
        if (extraInstructions) prompt += `\n\n${extraInstructions}`;
        if (target === "new-branch") {
          const branches = await command(
            "git",
            ["branch", "--all", "--format=%(refname:short)"],
            ctx.cwd,
            actionController!.signal,
          );
          prompt += `\n\nExisting local and remote branches (do not reuse any of these names):\n${branches || "(none)"}`;
        }

        const request = (signal: AbortSignal) => runSubagent({
          prompt,
          cwd: ctx.cwd,
          provider: PROVIDER,
          model: MODEL_ID,
          tools: ["read", "grep", "find", "ls", "bash"],
          schema: schemas[target],
          signal,
        });

        if (ctx.mode !== "tui") {
          return (await request(actionController!.signal)).data as Generated;
        }

        let generationError: unknown;
        const generated = await ctx.ui.custom<Generated | null>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, `Generating /${target} content…`);
          let finished = false;
          const finish = (result: Generated | null) => {
            if (finished) return;
            finished = true;
            done(result);
          };

          loader.onAbort = () => finish(null);
          void request(loader.signal)
            .then((result) => finish(result.data as Generated))
            .catch((error) => {
              generationError = error;
              finish(null);
            });
          return loader;
        });

        if (generationError) throw generationError;
        if (!generated) throw new Error("Generation cancelled");
        return generated;
      };

      let stageAll = false;
      if (action === "commit") {
        const currentBranch = await command("git", ["branch", "--show-current"], ctx.cwd, actionController.signal);
        if (currentBranch === "main") {
          const destination = await ctx.ui.select(
            "You are currently on main. Where should this commit go?",
            ["Create a new branch", "Commit directly to main"],
          );
          if (!destination) return;
          if (destination === "Create a new branch") {
            const branch = await generate("new-branch", "");
            await apply("new-branch", branch, ctx.cwd, actionController.signal);
          }
        }

        const status = await command("git", ["status", "--porcelain"], ctx.cwd, actionController.signal);
        const hasUnstaged = status.split("\n").some((line) => line.startsWith("??") || (line.length > 1 && line[1] !== " "));
        if (hasUnstaged) {
          stageAll = await ctx.ui.confirm("Unstaged changes", "Stage all changes before committing?");
        }
      }

      const generated = await generate(
        action,
        args.trim(),
        action === "commit"
          ? stageAll
            ? "Generate the message for all staged and unstaged changes, because all changes will be staged before committing."
            : "Generate the message ONLY from the staged diff (git diff --cached). Ignore every unstaged and untracked change."
          : "",
      );
      ctx.ui.setStatus("git-actions", `/${action} applying…`);
      const summary = await apply(action, generated, ctx.cwd, actionController.signal, stageAll);
      ctx.ui.notify(summary, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`/${action} failed: ${message}`, "error");
    } finally {
      actionRunning = false;
      actionController = undefined;
      ctx.ui.setStatus("git-actions", undefined);
    }
  }

  for (const action of ["commit", "new-branch", "pr"] as const) {
    pi.registerCommand(action, {
      description: action === "commit"
        ? `Generate a message and commit programmatically using ${MODEL_ID}`
        : action === "new-branch"
          ? `Generate and create a branch programmatically using ${MODEL_ID}`
          : `Generate and create a pull request programmatically using ${MODEL_ID}`,
      handler: (args, ctx) => run(action, args, ctx),
    });
  }
}
