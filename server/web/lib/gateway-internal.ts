/**
 * The brain's side of the service gateway's own two routes
 * (/api/gateway/registry, /api/gateway/calls; docs/gateway.md). The
 * gateway holds no database login: it reads the services it may route to
 * here and sends its call rows back here, with GATEWAY_TOKEN.
 *
 * A request is the gateway's only when it carries the token AND came
 * straight from the stack's network: the front door (Caddy) adds
 * X-Forwarded-For to every request it passes on, so one that carries it
 * came from outside the box and is refused before the token is read.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '@mantle/config';
import { reapGatewayCalls } from '@mantle/db';
import { NextResponse } from '@/server/http-compat';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Null when the request is the gateway's, else the answer to send. */
export function gatewayRequestRefusal(req: Request): Response | null {
  // Through the front door: not the gateway, whatever it carries.
  if (req.headers.has('x-forwarded-for') || req.headers.has('forwarded')) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  // No token on the box: no gateway can prove itself, the same 401.
  const token = env('GATEWAY_TOKEN') ?? '';
  const got = req.headers.get('x-mantle-gateway-token') ?? '';
  if (!token || !got || !timingSafeEqual(digest(got), digest(token))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

const REAP_EVERY_MS = 60 * 60_000;
let lastReap = 0;

/** Remove call rows past their 90 days, at most once an hour per process,
 *  in the background (a batch never waits on it). */
export function reapGatewayCallsSoon(): void {
  const now = Date.now();
  if (now - lastReap < REAP_EVERY_MS) return;
  lastReap = now;
  void reapGatewayCalls().catch((err: unknown) => {
    console.error('[gateway] call log reap failed', err);
  });
}
