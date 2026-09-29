/**
 * Email sign-in codes for client logins (client logins C2b), public under
 * /api/auth.
 *
 * GET  /api/auth/client-code -> ClientCodeAvailability: whether this brain
 *      sends codes: an admin chose a sign-in sender AND an email worker
 *      serves the code queue on this box. Nothing about emails.
 * POST /api/auth/client-code { email } -> always 200 { ok: true } with the
 *      request cookie, whatever the email and whatever the body: the same
 *      answer and the same work on every branch. A browser that already has
 *      a request cookie keeps its id (so asking again, or a double click,
 *      never strands the code already mailed); otherwise the id is new. The
 *      route only queues the request, and only while a sender is chosen (no
 *      sender: nothing is queued, for every email alike); the email-sync
 *      worker looks the email up, applies the caps, stores the code and
 *      mails it (lib/client-codes.ts). So neither the answer, the cookie nor
 *      the timing tells whether an email is a client. Rate limited per
 *      address, an IPv6 caller by its /64 (429), which says nothing either.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import type { ClientCodeAvailability, ClientCodeRequested } from '@mantle/client-types';
import { clientIpKey } from '@/lib/rate-limit';
import {
  emailWorkerServesCodes,
  enqueueClientCode,
  loadClientSigninSender,
} from '@/lib/client-codes';
import {
  clientCodeRequestLimited,
  existingRequestId,
  setClientCodeCookie,
} from '@/lib/client-logins';
import { refuseCrossSiteAuthPost } from '@/lib/auth/preflight';
import { AUTH_BODY_CEILING_BYTES, readJsonCapped } from '@/lib/body-limit';

export async function GET() {
  // Fail closed: when the sender cannot be read, codes are off (never a 500
  // on a public page's first question).
  const [sender, worker] = await Promise.all([
    loadClientSigninSender().catch(() => null),
    emailWorkerServesCodes().catch(() => false),
  ]);
  const body: ClientCodeAvailability = { enabled: !!sender && worker };
  return NextResponse.json(body);
}

export async function POST(req: Request) {
  const refused = refuseCrossSiteAuthPost(req);
  if (refused) return refused;
  const limited = clientCodeRequestLimited(req);
  if (limited) return limited;

  const raw = (await readJsonCapped(req, AUTH_BODY_CEILING_BYTES)) as { email?: unknown } | null;
  const email = typeof raw?.email === 'string' ? raw.email.trim().slice(0, 320) : '';
  const requestId = existingRequestId(req) ?? randomUUID();
  try {
    // Codes off (no sender): nothing to queue, and nothing of an email or
    // an address kept in the queue. The same for every email.
    const sender = await loadClientSigninSender().catch(() => null);
    if (sender) {
      await enqueueClientCode({
        email,
        requestId,
        ip: clientIpKey(req),
        requestedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    // The answer stays the same: a queue that is down is an operator's
    // problem, never a signal to the caller.
    console.error('[client-code] enqueue failed', err instanceof Error ? err.message : err);
  }
  const body: ClientCodeRequested = { ok: true };
  const res = NextResponse.json(body);
  setClientCodeCookie(res, req, requestId);
  return res;
}
