import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { requestOrigin } from '@/lib/auth-constants';
import { dbMcpOAuthStore, startMcpOAuth } from '@mantle/tools';

/** Begin (or restart) the OAuth authorization flow for a connector — used on
 *  first connect and whenever the connector reports `needs_reconnect`. The
 *  response's `authorizeUrl` is opened in the OWNER'S browser; the provider
 *  redirects back to /api/mcp-connectors/oauth/callback. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { slug } = await params;
  const groupSlug = slug.startsWith('mcp-') ? slug : `mcp-${slug}`;
  try {
    const redirectUri = `${requestOrigin(req)}/api/mcp-connectors/oauth/callback`;
    const flow = await startMcpOAuth(dbMcpOAuthStore(user.id, groupSlug), { redirectUri });
    return NextResponse.json(
      'authorizeUrl' in flow ? { authorizeUrl: flow.authorizeUrl } : { alreadyAuthorized: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('not an MCP connector') ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
