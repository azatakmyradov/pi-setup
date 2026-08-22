import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Node reports an already-existing file through the `code` property of its error. */
const fileSystemErrorSchema = z.object({ code: z.string() });

function textContent(content: AssistantMessage["content"]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

export default function saveMarkdownExtension(pi: ExtensionAPI) {
  pi.registerCommand("save-md", {
    description: "Save the latest assistant response as Markdown (usage: /save-md name)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const branch = ctx.sessionManager.getBranch();
      let assistantMessage: AssistantMessage | undefined;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry?.type === "message" && entry.message.role === "assistant") {
          assistantMessage = entry.message;
          break;
        }
      }
      if (!assistantMessage) {
        ctx.ui.notify("No assistant response to save", "warning");
        return;
      }

      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /save-md name", "warning");
        return;
      }

      const markdown = textContent(assistantMessage.content);
      if (!markdown.trim()) {
        ctx.ui.notify("The latest assistant response has no Markdown text", "warning");
        return;
      }

      const fileName = name.endsWith(".md") ? name : `${name}.md`;
      const path = resolve(ctx.cwd, fileName);

      try {
        await writeFile(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        const fileSystemError = fileSystemErrorSchema.safeParse(error);
        if (fileSystemError.success && fileSystemError.data.code === "EEXIST") {
          ctx.ui.notify(`File already exists: ${path}`, "error");
          return;
        }
        throw error;
      }

      ctx.ui.notify(`Saved Markdown to ${path}`, "info");
    },
  });
}
