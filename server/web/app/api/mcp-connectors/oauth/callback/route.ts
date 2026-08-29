import { getOwnerOr401 } from '@/lib/auth';
import {
  completeMcpOAuth,
  dbMcpOAuthStore,
  findConnectorByOAuthState,
  syncMcpConnector,
} from '@mantle/tools';

/** Minimal self-closing result page — the flow runs in a spare browser tab. */
function htmlPage(title: string, detail: string, ok: boolean): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:32rem;text-align:center">
<h1 style="font-size:1.25rem">${ok ? '✅' : '⚠️'} ${title}</h1>
<p style="color:#555">${detail}</p>
<p style="color:#999;font-size:.85rem">You can close this tab.</p>
</div></body>`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * OAuth redirect target. Owner-gated: the flow starts in the owner's own
 * browser session, so the session cookie rides along; an unauthenticated hit
 * gets the normal 401 rather than leaking flow state.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const providerError = url.searchParams.get('error');

  const groupSlug = await findConnectorByOAuthState(user.id, state);
  if (!groupSlug) {
    return htmlPage(
      'Unknown authorization',
      'This link does not match a connector waiting for authorization. Start the flow again from the connector.',
      false,
    );
  }
  if (providerError || !code) {
    const desc = url.searchParams.get('error_description') ?? providerError ?? 'no code returned';
    return htmlPage(`Authorization failed for ${esc(groupSlug)}`, esc(desc), false);
  }

  try {
    await completeMcpOAuth(dbMcpOAuthStore(user.id, groupSlug), { code });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return htmlPage(`Authorization failed for ${esc(groupSlug)}`, esc(msg), false);
  }

  try {
    const sync = await syncMcpConnector(user.id, groupSlug);
    return htmlPage(
      `${esc(groupSlug)} connected`,
      `Authorized and synced ${sync.toolSlugs.length} tools. Grant the '${esc(groupSlug)}' tool group to an agent to use them.`,
      true,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return htmlPage(
      `${esc(groupSlug)} authorized, sync failed`,
      `Tokens are stored, but listing the server's tools failed: ${esc(msg)}. Re-run sync via POST /api/mcp-connectors/${esc(groupSlug)}/sync.`,
      false,
    );
  }
}
