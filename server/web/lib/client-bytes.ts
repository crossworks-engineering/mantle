import { NextResponse } from '@/server/http-compat';
import type { ClientCaller } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';

/**
 * The client twin of memberBytesGate (lib/member-space.ts), for the client
 * byte routes (client logins C2): requests per login per minute, a thumbnail
 * (which may decode an image) on its own, smaller budget. The same numbers
 * as a member's.
 */
export const CLIENT_BYTES_PER_MIN = 240;
export const CLIENT_THUMBS_PER_MIN = 60;

/** A 429 with Retry-After, or null to go on. Checked before any file is
 *  opened. */
export function clientBytesGate(req: Request, client: ClientCaller): Response | null {
  const thumb = new URL(req.url).searchParams.get('thumb') === '1';
  const gate = thumb
    ? rateLimit(`client-thumbs:${client.loginId}`, {
        max: CLIENT_THUMBS_PER_MIN,
        windowMs: 60_000,
      })
    : rateLimit(`client-bytes:${client.loginId}`, { max: CLIENT_BYTES_PER_MIN, windowMs: 60_000 });
  if (gate.ok) return null;
  return NextResponse.json(
    { error: 'Too many requests. Try again shortly.', reason: 'rate-limit' },
    { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
  );
}
