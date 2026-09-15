/**
 * Server-side helpers for MCP connectors — thin wrappers over the engine in
 * @mantle/tools (mcp-sync.ts / mcp-client.ts). A connector IS a `tool_groups`
 * row whose `integration.mcp` binds an external MCP server; there is no
 * second entity. These helpers add the API-facing composition: connector
 * listing with grant fan-out, the known-servers catalog with configured
 * flags, and binding edits that bounce the cached client.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, toolGroups, type ToolGroup, type ToolGroupMcpBinding } from '@mantle/db';
import { listApiKeys } from '@mantle/api-keys';
import { getConfigStatus } from '@mantle/microsoft';
import {
  closeMcpClient,
  dbMcpOAuthStore,
  KNOWN_MCP_SERVERS,
  mcpGroupSlug,
  parseMcpBinding,
  setMcpOAuthClient,
  type KnownMcpServer,
  type McpOAuthClientInput,
} from '@mantle/tools';
import { errorMessage } from '@mantle/std';
import { requestOrigin } from '@/lib/auth-constants';
import { listToolGroupBackrefs } from '@/lib/tool-groups';
import type { ToolGroupDTO } from '@mantle/client-types';

/** Where every connector's OAuth flow lands. One helper, so the URI the
 *  owner registers in Azure (shown on the connectors screen) and the one the
 *  flow sends can never drift apart. */
export function connectorOAuthCallbackUrl(req: Request): string {
  return `${requestOrigin(req)}/api/mcp-connectors/oauth/callback`;
}

/** Request body for a connector's OAuth app (create + patch). */
export const McpOAuthClientBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('dynamic') }),
  z.object({ source: z.literal('microsoft') }),
  z.object({
    source: z.literal('manual'),
    clientId: z.string().trim().min(1, 'a manual app needs its client id').max(300),
    clientSecret: z.string().max(2000).optional(),
    authorizationServer: z
      .string()
      .trim()
      .max(2000)
      .regex(/^https:\/\/\S+$/i, 'authorizationServer must be an https:// URL')
      .optional(),
  }),
]);

/** OAuth scope override: space-separated, '' clears. */
export const McpOAuthScopeBody = z.string().max(1000);

export type McpConnectorSummary = ToolGroupDTO & { grantedTo: string[] };

/** Services (= connector group slugs) that currently hold sealed OAuth
 *  tokens. Presence is the truth about "connected": the stored status field
 *  can go stale if the token row is removed out-of-band. */
async function oauthTokenServices(ownerId: string): Promise<Set<string>> {
  const rows = await listApiKeys(ownerId);
  return new Set(rows.filter((k) => k.label === 'oauth-tokens').map((k) => k.service));
}

function toDTO(g: ToolGroup, grantedTo: string[], tokenServices: Set<string>): McpConnectorSummary {
  let integration = g.integration ?? null;
  const oauth = integration?.mcp?.oauth;
  // Derive, don't trust: a 'connected' claim without tokens in the vault is a
  // reconnect waiting to happen — show it as one.
  if (integration?.mcp && oauth?.status === 'connected' && !tokenServices.has(g.slug)) {
    integration = {
      ...integration,
      mcp: {
        ...integration.mcp,
        oauth: { ...oauth, status: 'needs_reconnect', lastError: 'stored tokens are missing' },
      },
    };
  }
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    toolSlugs: g.toolSlugs ?? [],
    integration,
    enabled: g.enabled,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    grantedTo,
  };
}

/** The Settings → Microsoft app as the connectors screen needs it: whether a
 *  connector can borrow it, and which app / tenant that would be. Non-secret. */
export type MicrosoftAppSummary =
  { configured: false } | { configured: true; clientId: string; tenant: string };

export async function listMcpConnectors(
  ownerId: string,
  opts: { oauthRedirectUri: string },
): Promise<{
  connectors: McpConnectorSummary[];
  catalog: Array<KnownMcpServer & { connected: boolean }>;
  /** The callback URL an OAuth app must list as a (Web) redirect URI. */
  oauthRedirectUri: string;
  microsoftApp: MicrosoftAppSummary;
}> {
  const [rows, backrefs, tokenServices, ms] = await Promise.all([
    db.select().from(toolGroups).where(eq(toolGroups.ownerId, ownerId)),
    listToolGroupBackrefs(ownerId),
    oauthTokenServices(ownerId),
    getConfigStatus(ownerId),
  ]);
  const connectors = rows
    .filter((g) => g.integration?.mcp)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((g) => toDTO(g, backrefs.get(g.slug) ?? [], tokenServices));
  const have = new Set(connectors.map((c) => c.slug));
  const catalog = KNOWN_MCP_SERVERS.map((s) => ({
    ...s,
    connected: have.has(mcpGroupSlug(s.slug)),
  }));
  const microsoftApp: MicrosoftAppSummary =
    ms.configured && ms.clientId
      ? { configured: true, clientId: ms.clientId, tenant: ms.tenant ?? 'common' }
      : { configured: false };
  return { connectors, catalog, oauthRedirectUri: opts.oauthRedirectUri, microsoftApp };
}

export async function getMcpConnector(
  ownerId: string,
  groupSlug: string,
): Promise<McpConnectorSummary | null> {
  const [row] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  if (!row?.integration?.mcp) return null;
  const [backrefs, tokenServices] = await Promise.all([
    listToolGroupBackrefs(ownerId),
    oauthTokenServices(ownerId),
  ]);
  return toDTO(row, backrefs.get(row.slug) ?? [], tokenServices);
}

export type UpdateMcpConnectorInput = {
  name?: string;
  enabled?: boolean;
  url?: string;
  /** '' clears the credential; undefined leaves it. */
  secretRef?: string;
  authHeader?: string;
  authScheme?: string;
  /** Switch the connector's OAuth app (OAuth connectors only). */
  oauthClient?: McpOAuthClientInput;
  /** OAuth scope override; '' clears it. */
  scope?: string;
};

/** Patch a connector's binding/name/enabled. A binding change closes the
 *  cached client so the next call reconnects with the new config. Returns a
 *  teaching error string instead of throwing on invalid input. */
export async function updateMcpConnector(
  ownerId: string,
  groupSlug: string,
  patch: UpdateMcpConnectorInput,
): Promise<{ connector: McpConnectorSummary } | { error: string; status: number }> {
  const [row] = await db
    .select()
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, groupSlug)))
    .limit(1);
  const mcp = row?.integration?.mcp;
  if (!row || !mcp) return { error: `MCP connector '${groupSlug}' not found`, status: 404 };

  const bindingTouched =
    patch.url !== undefined ||
    patch.secretRef !== undefined ||
    patch.authHeader !== undefined ||
    patch.authScheme !== undefined;

  let nextMcp: ToolGroupMcpBinding = mcp;
  if (bindingTouched) {
    const merged: Record<string, unknown> = {
      ...mcp,
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.authHeader !== undefined ? { authHeader: patch.authHeader } : {}),
      ...(patch.authScheme !== undefined ? { authScheme: patch.authScheme } : {}),
    };
    if (patch.secretRef !== undefined) {
      if (patch.secretRef === '') delete merged.secretRef;
      else merged.secretRef = patch.secretRef;
    }
    const parsed = parseMcpBinding(merged);
    if (!parsed.ok) return { error: parsed.error, status: 400 };
    nextMcp = parsed.value;
  }

  const oauthTouched = patch.oauthClient !== undefined || patch.scope !== undefined;
  if (oauthTouched && !mcp.oauth?.enabled) {
    return {
      error: `'${groupSlug}' does not use OAuth, so it has no OAuth app or scope to set`,
      status: 400,
    };
  }

  let [updated] = await db
    .update(toolGroups)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(bindingTouched ? { integration: { ...row.integration!, mcp: nextMcp } } : {}),
      updatedAt: new Date(),
    })
    .where(eq(toolGroups.id, row.id))
    .returning();
  // After the row update, never before: that update writes the binding it
  // read, which would clobber a fresher oauth block.
  if (oauthTouched) {
    try {
      await setMcpOAuthClient(dbMcpOAuthStore(ownerId, groupSlug), {
        client: patch.oauthClient,
        scope: patch.scope,
      });
    } catch (err) {
      return { error: errorMessage(err), status: 400 };
    }
    [updated] = await db.select().from(toolGroups).where(eq(toolGroups.id, row.id)).limit(1);
  }
  if (bindingTouched || oauthTouched) await closeMcpClient(ownerId, groupSlug);
  const [backrefs, tokenServices] = await Promise.all([
    listToolGroupBackrefs(ownerId),
    oauthTokenServices(ownerId),
  ]);
  return { connector: toDTO(updated!, backrefs.get(groupSlug) ?? [], tokenServices) };
}
