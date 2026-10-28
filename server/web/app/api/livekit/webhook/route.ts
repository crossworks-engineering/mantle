/**
 * POST /api/livekit/webhook (calls plan page 886126b4, sections 5, 9 and
 * 11): LiveKit tells the brain what happened in a room (a participant
 * joined or left, the room closed). No session: the credential is the
 * JWT in Authorization, signed with the API secret and carrying the sha256
 * of the body, verified on the RAW bytes. Any failure is one 401 with no
 * side effect; the body is never logged. A replayed event id is a no-op
 * (the call store keeps every id for a day).
 */
import { NextResponse } from '@/server/http-compat';
import { readBodyCapped, WEBHOOK_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { applyCallWebhook, verifyLivekitWebhook } from '@/lib/messenger';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'public',
    item: { none: 'a public route: it judges its own credential (the LiveKit signature)' },
    limits: { rateLimit: ['livekitWebhook'] },
  },
});

export async function POST(req: Request) {
  const raw = await readBodyCapped(req, WEBHOOK_BODY_CEILING_BYTES);
  let event;
  try {
    event = await verifyLivekitWebhook(raw, req.headers.get('authorization'));
  } catch {
    // Unsigned, badly signed, tampered, or not an event: the one answer,
    // and nothing written. The reason stays out of the reply and the log.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const outcome = await applyCallWebhook(event);
  return NextResponse.json({ ok: true, outcome });
}
