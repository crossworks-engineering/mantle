/**
 * An optional service's own screens in a sandboxed frame (Sync service plan
 * M2, decision 3): GET and POST /api/services/<name>/ui?p=<path>&t=<ticket>
 * hand the request to the service, with its token, and answer its HTML
 * under a strict policy (no script, no outside resource, forms to this
 * route only). The service builds every link and form through this route.
 */
import { env, serviceEnabled } from '@mantle/config';
import { NET_TIMEOUTS, timeoutSignal } from '@mantle/std';
import { loginHasArea } from '@mantle/db';
import { buildServiceFrameTicket, verifyServiceFrameTicket } from '@/lib/auth';
import { SYNC_TOKEN_HEADER } from '@/lib/sidecar';
import { requestOrigin } from '@/lib/auth-constants';
import { frameAncestors } from '@/lib/canvas-frame';

/** The services that serve screens. */
export const SCREEN_SERVICES = ['sync'] as const;

/** A screen path: lowercase segments, as the sidecar names them. */
const PATH_RE = /^\/[a-z0-9/-]{0,200}$/;
/** The largest form a screen posts. */
const FORM_MAX_BYTES = 256 * 1024;

/** No script, no outside resource; forms post back to this brain only; the
 *  frame may sit in the brain's own pages and its named clients (the canvas
 *  frame's list). */
function csp(req: Request): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    `form-action 'self' ${requestOrigin(req)}`,
    "base-uri 'none'",
    `frame-ancestors 'self' ${frameAncestors().join(' ')}`,
  ].join('; ');
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Answer one screen request of `service`. */
export async function serviceScreen(req: Request, service: string): Promise<Response> {
  if (!SCREEN_SERVICES.includes(service as never)) return plain(404, 'not found');
  const url = new URL(req.url);
  const ticket = verifyServiceFrameTicket(url.searchParams.get('t') ?? '');
  // The ticket, and its login still holding the area: the two checks.
  if (!ticket || ticket.service !== service)
    return plain(401, 'This screen has expired. Open it again.');
  if (!(await loginHasArea(ticket.actorId, 'connectors'))) return plain(403, 'not allowed');
  if (!serviceEnabled(service as never)) return plain(404, 'Sync is turned off on this box.');
  const path = url.searchParams.get('p') ?? '/';
  if (!PATH_RE.test(path)) return plain(404, 'not found');
  const method = req.method === 'POST' ? 'POST' : 'GET';
  const token = env('SYNC_TOKEN');
  if (!token) return plain(503, 'Sync is not wired on this box (no SYNC_TOKEN).');

  let body: string | undefined;
  if (method === 'POST') {
    body = await req.text();
    if (Buffer.byteLength(body) > FORM_MAX_BYTES) return plain(413, 'too large');
  }
  const base = (env('SYNC_URL') ?? 'http://sync:8099').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/ui${path === '/' ? '' : path}`, {
      method,
      headers: {
        [SYNC_TOKEN_HEADER]: token,
        'x-mantle-ui-base': `/api/services/${service}/ui`,
        // A fresh ticket for the answer's links and forms.
        'x-mantle-frame-ticket': buildServiceFrameTicket(ticket),
        'x-mantle-actor': ticket.actorId,
        // The brain's own address, for the redirect URI a provider app
        // registers (the Microsoft app screen suggests it).
        'x-mantle-ui-origin': requestOrigin(req),
        ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
      redirect: 'error',
      signal: timeoutSignal(NET_TIMEOUTS.syncScreen),
    });
  } catch {
    return plain(502, 'The Sync service did not answer. It may still be starting; try again.');
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('text/html')) {
    await res.body?.cancel().catch(() => {});
    return plain(res.status >= 400 ? res.status : 502, 'The Sync service gave no screen.');
  }
  return new Response(await res.text(), {
    status: res.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp(req),
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}
