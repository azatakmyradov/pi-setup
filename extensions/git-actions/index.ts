import { spawn } from "node:child_process";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { runSubagent, type SubagentOutputSchema } from "../shared/subagent.ts";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";

type Action = "commit" | "new-branch" | "pr";

/** Non-blank generated text, trimmed exactly as the applied Git command needs it. */
const generatedText = z.string().trim().min(1);

/**
 * What each action expects back from the generator. Decoding here is the only
 * gate between the model's JSON and the Git commands below.
 */
const generated = {
  commit: z
    .object({ message: generatedText })
    .transform((content) => ({ action: "commit" as const, ...content })),
  "new-branch": z
    .object({ name: generatedText })
    .transform((content) => ({ action: "new-branch" as const, ...content })),
  pr: z
    .object({ title: generatedText, body: generatedText, base: generatedText })
    .transform((content) => ({ action: "pr" as const, ...content })),
};

type Generated = z.infer<(typeof generated)[Action]>;

const schemas = {
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
} satisfies Record<Action, SubagentOutputSchema>;

const instructions = {
  commit: (args) =>
    `Inspect the Git status, relevant diff, and recent commit style. Generate only a concise commit message matching the repository convention. Do not modify files, stage changes, commit, or run validation. ${args ? `User instructions: ${args}` : ""}`,
  "new-branch": (args) =>
    `Inspect the current work and existing branch naming conventions. Generate only a safe, concise branch name. Do not create or switch branches and do not modify the repository. ${args ? `Use this name or description: ${args}` : "Use kebab-case and the customary prefix when evident."}`,
  pr: (args) =>
    `Inspect the current branch, default base branch, commits and diff against the base, and any PR template. Generate only the pull-request title, body, and base branch. Do not push, create a PR, modify files, or run validation. ${args ? `User instructions: ${args}` : "Include a concise summary and test status in the body."}`,
} satisfies Record<Action, (args: string) => string>;

function command(
  program: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return reject(new Error("Git action aborted"));
      if (code !== 0)
        return reject(new Error(stderr.trim() || `${program} exited with code ${code}`));
      resolve(stdout.trim());
    });
  });
}

/**
 * The one UI capability the loader needs: hosting a custom component. Accepting
 * this instead of the whole context keeps it callable with any host, including
 * the component recorder the tests use.
 */
export type CustomComponentHost = Pick<ExtensionUIContext, "custom">;

export async function runWithLoader<T>(
  ui: CustomComponentHost,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
  cancelledMessage: string,
): Promise<T> {
  let operationError: unknown;
  const result = await ui.custom<{ value: T } | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, message);
    let finished = false;
    const finish = (value: { value: T } | null) => {
      if (finished) return;
      finished = true;
      done(value);
    };

    loader.onAbort = () => finish(null);
    void operation(loader.signal)
      .then((value) => finish({ value }))
      .catch((error) => {
        operationError = error;
        finish(null);
      });
    return loader;
  });

  if (operationError) throw operationError;
  if (!result) throw new Error(cancelledMessage);
  return result.value;
}

async function apply(
  content: Generated,
  cwd: string,
  signal: AbortSignal,
  stageAll = false,
): Promise<string> {
  if (content.action === "commit") {
    const { message } = content;
    if (stageAll) await command("git", ["add", "-A"], cwd, signal);
    await command("git", ["commit", "-m", message], cwd, signal);
    const hash = await command("git", ["rev-parse", "--short", "HEAD"], cwd, signal);
    return `Committed ${hash}: ${message}`;
  }

  if (content.action === "new-branch") {
    const { name } = content;
    await command("git", ["check-ref-format", "--branch", name], cwd, signal);
    await command("git", ["switch", "-c", name], cwd, signal);
    return `Created and switched to ${name}`;
  }

  const { title, body, base } = content;
  const branch = await command("git", ["branch", "--show-current"], cwd, signal);
  if (!branch) throw new Error("Cannot create a PR from a detached HEAD");

  try {
    const existing = await command(
      "gh",
      ["pr", "view", "--json", "url", "--jq", ".url"],
      cwd,
      signal,
    );
    if (existing) return `Pull request already exists: ${existing}`;
  } catch {
    // No PR exists for this branch yet.
  }

  await command("git", ["push", "--set-upstream", "origin", branch], cwd, signal);
  const url = await command(
    "gh",
    ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body],
    cwd,
    signal,
  );
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
        const currentBranch = await command(
          "git",
          ["branch", "--show-current"],
          ctx.cwd,
          actionController.signal,
        );
        if (!currentBranch)
          throw new Error(
            "Cannot create a pull request from a detached HEAD. Switch to a branch first.",
          );
        if (currentBranch === "main")
          throw new Error(
            "Cannot create a pull request from main. Create or switch to a feature branch first.",
          );
      }

      const generate = async (
        target: Action,
        userArgs: string,
        extraInstructions = "",
      ): Promise<Generated> => {
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

        const request = async (signal: AbortSignal): Promise<Generated> => {
          const result = await runSubagent({
            prompt,
            cwd: ctx.cwd,
            provider: PROVIDER,
            model: MODEL_ID,
            tools: ["read", "grep", "find", "ls", "bash"],
            schema: schemas[target],
            signal,
          });
          const content = generated[target].safeParse(result.data);
          if (content.success) return content.data;
          const field = content.error.issues[0]?.path.join(".");
          throw new Error(
            field ? `Generator returned an invalid ${field}` : "Generator returned invalid data",
          );
        };

        if (ctx.mode !== "tui") return request(actionController!.signal);

        return runWithLoader(
          ctx.ui,
          `Generating /${target} content…`,
          request,
          "Generation cancelled",
        );
      };

      let stageAll = false;
      if (action === "commit") {
        const currentBranch = await command(
          "git",
          ["branch", "--show-current"],
          ctx.cwd,
          actionController.signal,
        );
        if (currentBranch === "main") {
          const destination = await ctx.ui.select(
            "You are currently on main. Where should this commit go?",
            ["Create a new branch", "Commit directly to main"],
          );
          if (!destination) return;
          if (destination === "Create a new branch") {
            const branch = await generate("new-branch", "");
            await apply(branch, ctx.cwd, actionController.signal);
          }
        }

        const status = await command(
          "git",
          ["status", "--porcelain"],
          ctx.cwd,
          actionController.signal,
        );
        const hasUnstaged = status
          .split("\n")
          .some((line) => line.startsWith("??") || (line.length > 1 && line[1] !== " "));
        if (hasUnstaged) {
          stageAll = await ctx.ui.confirm(
            "Unstaged changes",
            "Stage all changes before committing?",
          );
        }
      }

      const content = await generate(
        action,
        args.trim(),
        action === "commit"
          ? stageAll
            ? "Generate the message for all staged and unstaged changes, because all changes will be staged before committing."
            : "Generate the message ONLY from the staged diff (git diff --cached). Ignore every unstaged and untracked change."
          : "",
      );
      ctx.ui.setStatus("git-actions", `/${action} applying…`);
      const summary =
        action === "commit" && ctx.mode === "tui"
          ? await runWithLoader(
              ctx.ui,
              "Committing… Pre-commit hooks may take a while.",
              (signal) => apply(content, ctx.cwd, signal, stageAll),
              "Commit cancelled",
            )
          : await apply(content, ctx.cwd, actionController.signal, stageAll);
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
      description:
        action === "commit"
          ? `Generate a message and commit programmatically using ${MODEL_ID}`
          : action === "new-branch"
            ? `Generate and create a branch programmatically using ${MODEL_ID}`
            : `Generate and create a pull request programmatically using ${MODEL_ID}`,
      handler: (args, ctx) => run(action, args, ctx),
    });
  }
}
