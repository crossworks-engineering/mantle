/**
 * OAuth 2.1 authorization endpoint + consent screen.
 *
 * GET renders the consent page ("Allow Claude to access your Mantle brain") once
 * the owner is signed in; if they're not, it bounces to /login?next=… and comes
 * back. POST is the Allow/Deny decision: Allow mints a single-use PKCE-bound code
 * and 302s back to the client's registered redirect_uri with code+state.
 *
 * This endpoint USES the Mantle session (unlike the other OAuth routes, which
 * self-authenticate) — it's the human-in-the-loop step. The consent form carries
 * a session-bound HMAC token so a forged cross-site POST can't auto-approve.
 *
 * Security: if client_id or redirect_uri is invalid we render an error and do
 * NOT redirect (never bounce a code to an unvalidated URI).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { requestOrigin } from '@/lib/auth-constants';
import { getClient, isRemoteMcpEnabled, mintAuthCode, DEFAULT_SCOPE } from '@/lib/mcp-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  responseType: string;
};

function readParams(sp: URLSearchParams): AuthorizeParams {
  return {
    clientId: sp.get('client_id') ?? '',
    redirectUri: sp.get('redirect_uri') ?? '',
    state: sp.get('state') ?? '',
    codeChallenge: sp.get('code_challenge') ?? '',
    codeChallengeMethod: sp.get('code_challenge_method') ?? '',
    scope: sp.get('scope') || DEFAULT_SCOPE,
    responseType: sp.get('response_type') ?? '',
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlError(message: string, status = 400): Response {
  return new Response(consentShell(`<h1>Can't connect</h1><p class="muted">${escapeHtml(message)}</p>`), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Bind the consent form to (user, client, redirect, challenge) so only a POST
 *  originating from the page we rendered to THIS signed-in user is honoured. */
function consentToken(userId: string, p: AuthorizeParams): string {
  const secret = process.env.SESSION_SECRET ?? '';
  return createHmac('sha256', secret)
    .update(`${userId}:${p.clientId}:${p.redirectUri}:${p.codeChallenge}`)
    .digest('base64url');
}
function consentTokenValid(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validate the request against the registered client. Returns the validated
 *  client name on success, or an error Response (which the caller returns). */
async function validate(p: AuthorizeParams): Promise<{ clientName: string } | Response> {
  if (p.responseType !== 'code') return htmlError('unsupported response_type (only "code")');
  if (!p.clientId) return htmlError('missing client_id');
  if (!p.codeChallenge || p.codeChallengeMethod !== 'S256') {
    return htmlError('PKCE with code_challenge_method=S256 is required');
  }
  const client = await getClient(p.clientId);
  if (!client) return htmlError('unknown client_id');
  if (!p.redirectUri || !client.redirectUris.includes(p.redirectUri)) {
    return htmlError('redirect_uri does not match a registered URI');
  }
  return { clientName: client.clientName || 'An application' };
}

export async function GET(req: Request) {
  if (!(await isRemoteMcpEnabled())) return htmlError('Remote MCP is not enabled on this Mantle.', 404);
  const url = new URL(req.url);
  const p = readParams(url.searchParams);
  const validated = await validate(p);
  if (validated instanceof Response) return validated;

  const user = await getSessionUser();
  if (!user) {
    // Bounce through login, then return to this exact authorize request.
    const next = encodeURIComponent(url.pathname + url.search);
    return NextResponse.redirect(new URL(`/login?next=${next}`, requestOrigin(req)));
  }

  const token = consentToken(user.id, p);
  return new Response(consentPage(validated.clientName, p, token, user.email), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: Request) {
  if (!(await isRemoteMcpEnabled())) return htmlError('Remote MCP is not enabled on this Mantle.', 404);
  const form = await req.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  const p: AuthorizeParams = {
    clientId: get('client_id'),
    redirectUri: get('redirect_uri'),
    state: get('state'),
    codeChallenge: get('code_challenge'),
    codeChallengeMethod: get('code_challenge_method'),
    scope: get('scope') || DEFAULT_SCOPE,
    responseType: 'code',
  };
  const decision = get('decision');

  const validated = await validate(p);
  if (validated instanceof Response) return validated;

  const user = await getSessionUser();
  if (!user) return htmlError('your session expired — start the connection again', 401);

  if (!consentTokenValid(get('consent_token'), consentToken(user.id, p))) {
    return htmlError('consent could not be verified — start the connection again', 400);
  }

  // Deny → redirect back with an OAuth error (per spec), preserving state.
  if (decision !== 'allow') {
    const dest = new URL(p.redirectUri);
    dest.searchParams.set('error', 'access_denied');
    if (p.state) dest.searchParams.set('state', p.state);
    return NextResponse.redirect(dest, { status: 302 });
  }

  const code = await mintAuthCode({
    clientId: p.clientId,
    ownerId: user.id,
    codeChallenge: p.codeChallenge,
    codeChallengeMethod: p.codeChallengeMethod,
    redirectUri: p.redirectUri,
    scope: p.scope,
  });

  const dest = new URL(p.redirectUri);
  dest.searchParams.set('code', code);
  if (p.state) dest.searchParams.set('state', p.state);
  return NextResponse.redirect(dest, { status: 302 });
}

// ── Consent page (standalone, themed inline — not the app shell) ──────────────

function consentShell(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect to Mantle</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
    background:#0b0b0e; color:#e7e7ea; font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .card { width:min(420px,92vw); background:#16161b; border:1px solid #2a2a31; border-radius:14px;
    padding:28px 26px; box-shadow:0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size:19px; margin:0 0 6px; }
  .muted { color:#9a9aa3; font-size:13.5px; }
  .who { margin:14px 0 18px; padding:12px 14px; background:#0f0f13; border:1px solid #26262d; border-radius:10px; font-size:13.5px; }
  .who b { color:#e7e7ea; }
  .scopes { margin:0 0 20px; padding-left:18px; color:#c4c4cc; font-size:13.5px; }
  .row { display:flex; gap:10px; }
  button { flex:1; padding:11px 14px; border-radius:10px; border:1px solid transparent;
    font-size:14px; font-weight:600; cursor:pointer; }
  .allow { background:#6d6df0; color:#fff; }
  .deny { background:transparent; color:#c4c4cc; border-color:#33333b; }
  .foot { margin-top:16px; color:#74747d; font-size:12px; }
</style></head><body><div class="card">${inner}</div></body></html>`;
}

function consentPage(clientName: string, p: AuthorizeParams, token: string, email: string): string {
  const safeName = escapeHtml(clientName);
  const h = (v: string) => escapeHtml(v);
  const inner = `
  <h1>Connect ${safeName} to Mantle</h1>
  <p class="muted">${safeName} is requesting access to your Mantle brain.</p>
  <div class="who">Signed in as <b>${h(email)}</b></div>
  <p class="muted" style="margin-bottom:6px;">This will allow it to:</p>
  <ul class="scopes">
    <li>Read and write your notes, pages, tables, tasks, files, contacts and more</li>
    <li>Search your knowledge and act through your Mantle tools</li>
  </ul>
  <form method="post" action="/api/oauth/authorize">
    <input type="hidden" name="client_id" value="${h(p.clientId)}" />
    <input type="hidden" name="redirect_uri" value="${h(p.redirectUri)}" />
    <input type="hidden" name="state" value="${h(p.state)}" />
    <input type="hidden" name="code_challenge" value="${h(p.codeChallenge)}" />
    <input type="hidden" name="code_challenge_method" value="${h(p.codeChallengeMethod)}" />
    <input type="hidden" name="scope" value="${h(p.scope)}" />
    <input type="hidden" name="consent_token" value="${h(token)}" />
    <div class="row">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>
  <p class="foot">Only allow this if you started a connection from ${safeName}. You can disconnect anytime in Settings.</p>`;
  return consentShell(inner);
}
