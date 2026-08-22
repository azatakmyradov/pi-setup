// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import { z } from "zod";
import type { McpContent, ContentBlock } from "./types.ts";
import { stringifyUnknown } from "./utils.ts";

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map(c => {
    if (c.type === "text") {
      return { type: "text" as const, text: c.text ?? "" };
    }
    if (c.type === "image") {
      return {
        type: "image" as const,
        data: c.data ?? "",
        mimeType: c.mimeType ?? "image/png",
      };
    }
    if (c.type === "resource") {
      const resourceUri = c.resource?.uri ?? "(no URI)";
      const resourceContent = c.resource?.text ?? (c.resource ? JSON.stringify(c.resource) : "(no content)");
      return {
        type: "text" as const,
        text: `[Resource: ${resourceUri}]\n${resourceContent}`,
      };
    }
    if (c.type === "resource_link") {
      const linkName = c.name ?? c.uri ?? "unknown";
      const linkUri = c.uri ?? "(no URI)";
      return {
        type: "text" as const,
        text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
      };
    }
    if (c.type === "audio") {
      return {
        type: "text" as const,
        text: `[Audio content: ${c.mimeType ?? "audio/*"}]`,
      };
    }
    return { type: "text" as const, text: JSON.stringify(c) };
  });
}

/**
 * A resource read as it comes off the wire. Both the SDK client's
 * `readResource` and the Effect runtime's reply arrive as a reply envelope whose
 * `contents` entries the SDK only guarantees to be resource records, so the
 * entries are decoded here rather than trusted.
 */
const resourceReadReplySchema = z.object({
  contents: z.array(z.unknown()).optional(),
});

/** A resource entry the server delivered inline as text. */
const inlineTextResourceSchema = z.object({ text: z.string() });

/** A resource entry the server delivered as a base64 blob. */
const binaryResourceSchema = z.object({
  blob: z.string(),
  mimeType: z.string().optional(),
});

/**
 * Render the entries of a resource read as Pi content blocks: inline text
 * verbatim, a binary blob as a placeholder naming its media type, and anything
 * else as its JSON form.
 */
export function transformResourceContents<TReply>(reply: TReply): ContentBlock[] {
  const decoded = resourceReadReplySchema.safeParse(reply);
  const entries = decoded.success ? decoded.data.contents ?? [] : [];

  return entries.map((entry) => {
    const inlineText = inlineTextResourceSchema.safeParse(entry);
    if (inlineText.success) return { type: "text" as const, text: inlineText.data.text };

    const binary = binaryResourceSchema.safeParse(entry);
    if (binary.success) {
      return { type: "text" as const, text: `[Binary data: ${binary.data.mimeType ?? "unknown"}]` };
    }

    return { type: "text" as const, text: stringifyUnknown(entry) };
  });
}

/**
 * The parts of an MCP tool result this adapter renders back to the model.
 *
 * `structuredContent` is whatever the server put on the wire for its declared
 * output schema; it is only ever stringified here, so it stays unconstrained
 * rather than being decoded into the JSON domain (a decode would reject or
 * recurse forever on the non-serializable values this path must survive).
 */
export interface McpToolResultPayload {
  content?: McpContent[];
  structuredContent?: unknown;
}

/**
 * Resolve a tool result's content blocks, falling back to structuredContent
 * when content is empty.
 */
export function resolveMcpResultContent(result: McpToolResultPayload): ContentBlock[] {
  const blocks = transformMcpContent(result.content ?? []);
  if (blocks.length > 0) return blocks;

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return [{ type: "text" as const, text: stringifyStructuredContent(result.structuredContent) }];
  }

  return [];
}

function stringifyStructuredContent<TValue>(value: TValue): string {
  try {
    return JSON.stringify(value, null, 2) ?? stringifyUnknown(value);
  } catch {
    return stringifyUnknown(value);
  }
}
