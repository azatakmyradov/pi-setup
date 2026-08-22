// oauth-handler.ts - OAuth token management for MCP servers
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getAuthEntryFilePath } from "./mcp-auth.ts";

/**
 * Decodes the token document. `access_token` is the only member the caller can
 * do anything with, so it is required; the rest are recovered independently so
 * one stale member cannot hide a usable token.
 */
const storedOAuthTokensSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional().catch(undefined),
  refresh_token: z.string().optional().catch(undefined),
  expires_in: z.number().optional().catch(undefined),
  expiresAt: z.number().optional().catch(undefined),
});

// Token storage path for a server
function getTokensPath(serverName: string): string {
  return getAuthEntryFilePath(serverName);
}

/**
 * Get stored OAuth tokens for a server (if any).
 * Returns undefined if no tokens or tokens are expired.
 *
 * Token file location: $MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json when set,
 * otherwise <Pi agent dir>/mcp-oauth/sha256-<server-hash>/tokens.json
 *
 * Expected format:
 * {
 *   "access_token": "...",
 *   "token_type": "bearer",
 *   "refresh_token": "...",  // optional
 *   "expires_in": 3600,      // optional, seconds
 *   "expiresAt": 1234567890  // optional, absolute timestamp ms
 * }
 */
export function getStoredTokens(serverName: string): OAuthTokens | undefined {
  const tokensPath = getTokensPath(serverName);

  if (!existsSync(tokensPath)) return undefined;

  try {
    const decoded = storedOAuthTokensSchema.safeParse(JSON.parse(readFileSync(tokensPath, "utf-8")));
    if (!decoded.success) {
      return undefined;
    }
    const stored = decoded.data;

    // Check expiration if expiresAt is set
    if (stored.expiresAt && Date.now() > stored.expiresAt) {
      // Token expired
      return undefined;
    }

    return {
      access_token: stored.access_token,
      token_type: stored.token_type ?? "bearer",
      refresh_token: stored.refresh_token,
      expires_in: stored.expires_in,
    };
  } catch {
    return undefined;
  }
}
