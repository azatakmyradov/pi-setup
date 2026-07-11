import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";

type Action = "commit" | "new-branch" | "pr";

const instructions: Record<Action, (args: string) => string> = {
  commit: (args) => `Perform the Git commit action now. Inspect git status, staged and unstaged diffs, and recent commit style. Check for secrets and unrelated files. Stage only changes that belong together, run relevant focused validation when practical, and create one commit without amending or bypassing hooks. Never discard user changes. ${args ? `User instructions: ${args}` : "Infer a concise commit message matching the repository convention."} Finish with the commit hash, subject, files, and validation result.`,
  "new-branch": (args) => `Perform the create-branch action now. Inspect the current branch, repository status, existing branches, and naming conventions. Preserve all uncommitted changes and do not stash, reset, or discard anything. ${args ? `Use this branch name or description: ${args}` : "Infer a concise kebab-case branch name from the current work and conversation, including the repository's customary prefix when evident."} Create and switch to the branch, then report the old and new branch names. Ask only if no safe meaningful name can be inferred.`,
  pr: (args) => `Perform the pull-request action now. Inspect the current branch, remotes, default base branch, commits and diff against the base, PR template, and validation status. Ensure this is not the base branch and that there are commits to propose. Check for an existing PR first and return it instead of creating a duplicate. Run relevant validation when practical, push normally with upstream if needed (never force-push), then use the repository's preferred CLI (gh for GitHub) to open a PR. Respect the PR template and include summary, validation, and risks/follow-ups. ${args ? `User instructions: ${args}` : "Infer the base, title, and body; create a non-draft PR unless the work is clearly unfinished."} Finish with the URL, title, head/base branches, and validation result.`,
};

export default function (pi: ExtensionAPI) {
  let previousModel: Model<any> | undefined;
  let previousThinking: ReturnType<typeof pi.getThinkingLevel> | undefined;
  let actionRunning = false;

  async function run(action: Action, args: string, ctx: ExtensionCommandContext) {
    if (actionRunning || !ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent action to finish.", "warning");
      return;
    }

    const cheapModel = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
    if (!cheapModel) {
      ctx.ui.notify(`${PROVIDER}/${MODEL_ID} is unavailable.`, "error");
      return;
    }

    previousModel = ctx.model;
    previousThinking = pi.getThinkingLevel();

    if (!(await pi.setModel(cheapModel))) {
      previousModel = undefined;
      previousThinking = undefined;
      ctx.ui.notify(`No credentials available for ${PROVIDER}/${MODEL_ID}.`, "error");
      return;
    }

    actionRunning = true;
    pi.setThinkingLevel("low");
    ctx.ui.notify(`Running /${action} with ${MODEL_ID}…`, "info");
    pi.sendUserMessage(instructions[action](args.trim()));
  }

  for (const action of ["commit", "new-branch", "pr"] as const) {
    pi.registerCommand(action, {
      description: action === "commit"
        ? `Create a Git commit using ${MODEL_ID}`
        : action === "new-branch"
          ? `Create and switch branch using ${MODEL_ID}`
          : `Push and create a pull request using ${MODEL_ID}`,
      handler: (args, ctx) => run(action, args, ctx),
    });
  }

  pi.on("agent_settled", async (_event, ctx) => {
    if (!actionRunning) return;

    actionRunning = false;
    const modelToRestore = previousModel;
    const thinkingToRestore = previousThinking;
    previousModel = undefined;
    previousThinking = undefined;

    if (modelToRestore && ctx.model?.provider === PROVIDER && ctx.model.id === MODEL_ID) {
      await pi.setModel(modelToRestore);
      if (thinkingToRestore) pi.setThinkingLevel(thinkingToRestore);
      ctx.ui.notify(`Git action finished; restored ${modelToRestore.id}.`, "info");
    }
  });
}
