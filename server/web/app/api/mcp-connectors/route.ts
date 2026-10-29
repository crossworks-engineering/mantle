import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  createMcpConnector,
  dbMcpOAuthStore,
  mcpPairing,
  startMcpOAuth,
  vaultPairLoginRefusal,
} from '@mantle/tools';
import {
  connectorOAuthCallbackUrl,
  listMcpConnectors,
  McpOAuthClientBody,
  McpOAuthScopeBody,
} from '@/lib/mcp-connectors';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { toolMakerFor } from '@/lib/tools';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
  POST: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/** MCP connectors: external MCP servers consumed as per-connector tool
 *  groups. GET lists connected servers plus the known-servers catalog
 *  (placeholder rows for the settings UI); POST creates a connector and runs
 *  its first sync. See docs/mcp-connectors.md. */

export async function GET(req: Request) {
  const user = ownerCaller();
  const result = await listMcpConnectors(user.id, {
    oauthRedirectUri: connectorOAuthCallbackUrl(req),
  });
  return NextResponse.json(result);
}

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().max(120).optional(),
  url: z.string().min(1).max(2000),
  secretRef: z.string().max(160).optional(),
  authHeader: z.string().max(64).optional(),
  authScheme: z.string().max(20).optional(),
  /** True for a server that authenticates via the MCP OAuth flow — the
   *  response then carries `authorizeUrl` for the owner's browser. */
  oauth: z.boolean().optional(),
  /** The OAuth app (implies `oauth`): 'dynamic' (default) registers itself;
   *  'microsoft' borrows the Settings → Microsoft app; 'manual' is an app
   *  registered by hand. Needed for servers behind Microsoft Entra ID. */
  oauthClient: McpOAuthClientBody.optional(),
  /** OAuth scope override (implies `oauth`). */
  scope: McpOAuthScopeBody.optional(),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { oauthClient, scope, ...rest } = parsed.data;
  const oauth = !!(rest.oauth || oauthClient || scope);
  // A connector with a vault key sends it to its URL: pairing the two is the
  // keys area's (@mantle/tools secret-ref-gate.ts). An OAuth
  // connector's token is minted for its URL by the authorization itself.
  const configuredBy = toolMakerFor(user);
  if (mcpPairing({ url: rest.url, secretRef: rest.secretRef }).key) {
    const refused = await vaultPairLoginRefusal(configuredBy);
    if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  }
  // A binding the connector refuses (InputError) answers 400, a connector
  // already there (ConflictError) 409, by the one table.
  const result = await createMcpConnector(user.id, {
    ...rest,
    configuredBy,
    oauth,
    ...(oauthClient ? { oauthClient } : {}),
    ...(scope ? { oauthScope: scope } : {}),
  });
  try {
    if (oauth) {
      // Kick off the authorization flow immediately: discovery (+ dynamic
      // registration, unless the app is pre-registered) happens server-side;
      // the browser opens `authorizeUrl`.
      const flow = await startMcpOAuth(dbMcpOAuthStore(user.id, result.groupSlug), {
        redirectUri: connectorOAuthCallbackUrl(req),
      });
      return NextResponse.json(
        'authorizeUrl' in flow
          ? { ...result, authorizeUrl: flow.authorizeUrl }
          : { ...result, alreadyAuthorized: true },
        { status: 201 },
      );
    }
    // A created-but-unsynced connector is still a success: the group exists,
    // the caller fixes the config (or the server comes back) and re-syncs.
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // The connector EXISTS; only its authorization could not start. Report
    // that as such (the reason is also on the connector as lastError), not
    // as a failed create: the owner fixes the app choice and authorizes again.
    const msg = errorMessage(err);
    console.error('[mcp-connectors] authorize after create failed', result.groupSlug, msg);
    return NextResponse.json({ ...result, oauthError: msg }, { status: 201 });
  }
}
