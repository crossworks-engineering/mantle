/**
 * A Microsoft sign-in for the Sync service (Sync service plan M3, decision 1).
 * The sidecar runs the sign-in (state, PKCE, the client secret, the token
 * exchange); the brain only opens the door both ways:
 *
 *   GET /api/services/sync/oauth/start?t=<screen ticket>
 *       The ticket and its login's `connectors` area, then the sidecar's
 *       authorize address. A short cookie carries the sign-in's state.
 *   GET /api/services/sync/oauth/callback (and /api/microsoft/oauth/callback,
 *       the path an app registered before M4 names)
 *       Microsoft's redirect. The state must equal the cookie: a sign-in
 *       link someone else started cannot connect an account here. Then the
 *       sidecar finishes it.
 *
 * Every answer is a small page with no script; no error text of ours.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { serviceEnabled } from '@mantle/config';
import { loginHasArea } from '@mantle/db';
import { SyncAdminError, SyncOffError, syncAdmin } from '@mantle/email';
import { verifyServiceFrameTicket } from '@/lib/auth';
import { requestOrigin } from '@/lib/auth-constants';

export const OAUTH_COOKIE = 'mantle_sync_oauth';
const COOKIE_MAX_AGE_S = 600;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resultPage(status: number, title: string, text: string, clearCookie = false): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color-scheme:light dark}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  if (clearCookie)
    headers.append('set-cookie', `${OAUTH_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Lax`);
  return new Response(html, { status, headers });
}

function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === OAUTH_COOKIE) return v.join('=') || null;
  }
  return null;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** GET /api/services/sync/oauth/start?t= */
export async function syncOAuthStart(req: Request): Promise<Response> {
  const ticket = verifyServiceFrameTicket(new URL(req.url).searchParams.get('t') ?? '');
  // The ticket, and its login still holding the area: the two checks.
  if (!ticket || ticket.service !== 'sync') {
    return resultPage(401, 'Expired', 'This link has expired. Open Settings > Accounts again.');
  }
  if (!(await loginHasArea(ticket.actorId, 'connectors'))) {
    return resultPage(403, 'Not allowed', 'Your login may not connect accounts.');
  }
  if (!serviceEnabled('sync')) {
    return resultPage(404, 'Sync is off', 'Sync is turned off on this box.');
  }
  let started: { url: string; state: string };
  try {
    started = await syncAdmin<{ url: string; state: string }>('/oauth/start');
  } catch (err) {
    if (err instanceof SyncAdminError && err.status === 400) {
      return resultPage(400, 'Cannot sign in yet', err.message);
    }
    if (err instanceof SyncOffError) return resultPage(404, 'Sync is off', err.message);
    return resultPage(502, 'Sync did not answer', 'The Sync service did not answer. Try again.');
  }
  if (!started.url.startsWith('https://login.microsoftonline.com/')) {
    return resultPage(502, 'Sync did not answer', 'The Sync service gave no sign-in address.');
  }
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : '';
  return new Response(null, {
    status: 302,
    headers: {
      location: started.url,
      'set-cookie': `${OAUTH_COOKIE}=${started.state}; Path=/api; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`,
      'referrer-policy': 'no-referrer',
    },
  });
}

/** GET /api/services/sync/oauth/callback and /api/microsoft/oauth/callback */
export async function syncOAuthCallback(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const state = q.get('state') ?? '';
  const cookie = cookieOf(req);
  if (!state || !cookie || !same(state, cookie)) {
    return resultPage(
      400,
      'Sign-in not finished',
      'This sign-in was started in another browser, or it has expired. Start it again from Settings > Accounts.',
      true,
    );
  }
  try {
    const r = await syncAdmin<{ upn: string }>('/oauth/callback', {
      code: q.get('code') ?? undefined,
      state,
      error: q.get('error') ?? undefined,
      errorDescription: q.get('error_description') ?? undefined,
    });
    return resultPage(
      200,
      'Connected',
      `${r.upn} is connected. Close this tab and go back to Settings > Accounts to turn on its drives and mail.`,
      true,
    );
  } catch (err) {
    if (err instanceof SyncAdminError && err.status === 400) {
      return resultPage(400, 'Sign-in not finished', err.message, true);
    }
    return resultPage(
      502,
      'Sync did not answer',
      'The Sync service did not answer. Try again.',
      true,
    );
  }
}
