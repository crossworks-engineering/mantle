/**
 * POST /api/sidecar/mail/gate (Sync service plan M2; docs/email-ingest.md):
 * the Sync sidecar listed new messages of a mailbox; the brain answers which
 * to fetch: the sender passes the contacts gate, it is no client sign-in
 * code mail, and the mailbox does not hold it yet. Mail from anyone else is
 * never fetched.
 */
import { NextResponse } from '@/server/http-compat';
import { gateEnvelopes, mailboxOf } from '@mantle/email';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { GateBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, GateBody, { refuseEmpty: true });
  return asSidecar(async () => {
    const account = await mailboxOf(await sidecarOwner(), body.accountId);
    if (!account || !account.enabled) {
      return NextResponse.json({ error: 'no such mailbox' }, { status: 404 });
    }
    return NextResponse.json({ wanted: await gateEnvelopes(account, body.envelopes) });
  });
}
