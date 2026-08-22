import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { UrlElicitationRequiredError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ResourceFetchError, ResourceParseError } from "./errors.ts";
import { logger } from "./logger.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { UiResourceContent, UiResourceCsp, UiResourceMeta, UiResourcePermissions } from "./types.ts";
import { asJsonObject, asJsonText, jsonObjectSchema, type JsonObject } from "./json-value.ts";

interface ResourceContentRecord {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  /** Server-defined metadata bag from the MCP SDK; decode it before reading. */
  _meta?: unknown;
}

const domainListSchema = z.array(z.string()).optional();

/** The MCP-UI content-security-policy record a server may attach to a UI resource. */
const uiResourceCspSchema: z.ZodType<UiResourceCsp> = z.object({
  connectDomains: domainListSchema,
  scriptDomains: domainListSchema,
  styleDomains: domainListSchema,
  fontDomains: domainListSchema,
  imgDomains: domainListSchema,
  mediaDomains: domainListSchema,
  frameDomains: domainListSchema,
  workerDomains: domainListSchema,
  baseUriDomains: domainListSchema,
});

const grantSchema = z.object({}).optional();

const prefersBorderSchema = z.boolean();

/** The browser capabilities a server may request for its UI resource. */
const uiResourcePermissionsSchema: z.ZodType<UiResourcePermissions> = z.object({
  camera: grantSchema,
  microphone: grantSchema,
  geolocation: grantSchema,
  clipboardWrite: grantSchema,
});

export class UiResourceHandler {
  private log = logger.child({ component: "UiResourceHandler" });

  constructor(private manager: McpServerManager) {}

  async readUiResource(serverName: string, uri: string): Promise<UiResourceContent> {
    const log = this.log.child({ server: serverName, uri });

    if (!uri.startsWith("ui://")) {
      throw new ResourceParseError(uri, "URI must start with ui://", { server: serverName });
    }

    log.debug("Fetching UI resource");

    let result: ReadResourceResult;
    try {
      result = await this.manager.readResource(serverName, uri);
    } catch (error) {
      if (error instanceof UrlElicitationRequiredError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to read resource", error instanceof Error ? error : undefined);
      throw new ResourceFetchError(uri, message, {
        server: serverName,
        cause: error instanceof Error ? error : undefined,
      });
    }

    const content = selectContent(result, uri);
    const mimeType = content.mimeType;

    if (mimeType && !isHtmlMimeType(mimeType)) {
      log.warn("Unsupported MIME type", { mimeType });
      throw new ResourceParseError(
        uri,
        `unsupported MIME type "${mimeType}" (expected text/html or ${RESOURCE_MIME_TYPE})`,
        { server: serverName, mimeType }
      );
    }

    const html = toHtml(content);
    if (!html.trim()) {
      log.warn("Resource content is empty");
      throw new ResourceParseError(uri, "content is empty", { server: serverName });
    }

    const decodedContentMeta = jsonObjectSchema.safeParse(content._meta);
    const contentMeta = extractUiMeta(decodedContentMeta.success ? decodedContentMeta.data : undefined);
    const listMeta = extractUiMeta(this.getListResourceMeta(serverName, uri));

    log.debug("Resource loaded successfully", {
      contentLength: html.length,
      hasCsp: !!contentMeta.csp || !!listMeta.csp,
    });

    return {
      uri: content.uri ?? uri,
      html,
      mimeType: mimeType ?? RESOURCE_MIME_TYPE,
      meta: {
        csp: contentMeta.csp ?? listMeta.csp,
        permissions: contentMeta.permissions ?? listMeta.permissions,
        domain: contentMeta.domain ?? listMeta.domain,
        prefersBorder: contentMeta.prefersBorder ?? listMeta.prefersBorder,
      },
    };
  }

  private getListResourceMeta(serverName: string, uri: string): JsonObject | undefined {
    const connection = this.manager.getConnection(serverName);
    if (!connection?.resources?.length) return undefined;
    const resource = connection.resources.find((entry) => entry.uri === uri);
    const meta = jsonObjectSchema.safeParse(resource?._meta);
    return meta.success ? meta.data : undefined;
  }
}

function selectContent(result: ReadResourceResult, preferredUri: string): ResourceContentRecord {
  const contents: ResourceContentRecord[] = result.contents ?? [];
  if (contents.length === 0) {
    throw new Error(`No contents returned for UI resource: ${preferredUri}`);
  }

  const byUri = contents.find((content) => content.uri === preferredUri);
  if (byUri) return byUri;

  const byHtmlMime = contents.find(
    (content) => content.mimeType && isHtmlMimeType(content.mimeType)
  );
  if (byHtmlMime) return byHtmlMime;

  return contents[0];
}

function isHtmlMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith("text/html") || normalized === RESOURCE_MIME_TYPE.toLowerCase();
}

function toHtml(content: ResourceContentRecord): string {
  if (content.text !== undefined) {
    return content.text;
  }

  if (content.blob !== undefined) {
    return Buffer.from(content.blob, "base64").toString("utf-8");
  }

  throw new Error(`UI resource ${content.uri ?? "(unknown)"} did not include text or blob content`);
}

function extractUiMeta(meta: JsonObject | undefined): UiResourceMeta {
  const ui = asJsonObject(meta?.ui);
  if (!ui) return {};

  const out: UiResourceMeta = {};

  const csp = uiResourceCspSchema.safeParse(ui.csp);
  if (csp.success) {
    out.csp = csp.data;
  }
  const permissions = uiResourcePermissionsSchema.safeParse(ui.permissions);
  if (permissions.success) {
    out.permissions = permissions.data;
  }
  const domain = asJsonText(ui.domain);
  if (domain !== undefined) {
    out.domain = domain;
  }
  const prefersBorder = prefersBorderSchema.safeParse(ui.prefersBorder);
  if (prefersBorder.success) {
    out.prefersBorder = prefersBorder.data;
  }

  return out;
}
