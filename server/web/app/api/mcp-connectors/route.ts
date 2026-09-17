import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createMcpConnector, dbMcpOAuthStore, startMcpOAuth } from '@mantle/tools';
import {
  connectorOAuthCallbackUrl,
  listMcpConnectors,
  McpOAuthClientBody,
  McpOAuthScopeBody,
} from '@/lib/mcp-connectors';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

/** MCP connectors: external MCP servers consumed as per-connector tool
 *  groups. GET lists connected servers plus the known-servers catalog
 *  (placeholder rows for the settings UI); POST creates a connector and runs
 *  its first sync. See docs/mcp-connectors.md. */

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { oauthClient, scope, ...rest } = parsed.data;
  const oauth = !!(rest.oauth || oauthClient || scope);
  let result: Awaited<ReturnType<typeof createMcpConnector>>;
  try {
    result = await createMcpConnector(user.id, {
      ...rest,
      oauth,
      ...(oauthClient ? { oauthClient } : {}),
      ...(scope ? { oauthScope: scope } : {}),
    });
  } catch (err) {
    const msg = errorMessage(err);
    const status = msg.includes('already exists') ? 409 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
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
