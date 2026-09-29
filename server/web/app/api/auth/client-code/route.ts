/**
 * Email sign-in codes for client logins (client logins C2b), public under
 * /api/auth.
 *
 * GET  /api/auth/client-code -> ClientCodeAvailability: whether this brain
 *      sends codes (an admin chose a sign-in sender). Nothing about emails.
 * POST /api/auth/client-code { email } -> always 200 { ok: true } with the
 *      request cookie, whatever the email and whatever the body: the same
 *      answer and the same work on every branch. A browser that already has
 *      a request cookie keeps its id (so asking again, or a double click,
 *      never strands the code already mailed); otherwise the id is new. The route only queues
 *      the request; the email-sync worker looks the email up, applies the
 *      caps, stores the code and mails it (lib/client-codes.ts). So neither
 *      the answer, the cookie nor the timing tells whether an email is a
 *      client. Rate limited per address (429), which says nothing either.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import type { ClientCodeAvailability, ClientCodeRequested } from '@mantle/client-types';
import { clientIp } from '@/lib/rate-limit';
import { enqueueClientCode, loadClientSigninSender } from '@/lib/client-codes';
import {
  clientCodeRequestLimited,
  existingRequestId,
  setClientCodeCookie,
} from '@/lib/client-logins';

export async function GET() {
  // Fail closed: when the sender cannot be read, codes are off (never a 500
  // on a public page's first question).
  const sender = await loadClientSigninSender().catch(() => null);
  const body: ClientCodeAvailability = { enabled: !!sender };
  return NextResponse.json(body);
}

export async function POST(req: Request) {
  const limited = clientCodeRequestLimited(req);
  if (limited) return limited;

  const raw = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof raw?.email === 'string' ? raw.email.trim().slice(0, 320) : '';
  const requestId = existingRequestId(req) ?? randomUUID();
  try {
    await enqueueClientCode({
      email,
      requestId,
      ip: clientIp(req),
      requestedAt: new Date().toISOString(),
    });
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
