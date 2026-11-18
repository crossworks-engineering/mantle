/**
 * POST /api/sidecar/mail/ingest (Sync service plan M2; docs/email-ingest.md):
 * one message the Sync sidecar fetched in full. Stored as the old sync did
 * (ingest rules, the email node, attachments as file nodes), judged again by
 * the contacts gate, once per mailbox (both dedup keys). Its body ceiling is
 * MAIL_INGEST_BODY_BYTES (lib/body-limit.ts).
 */
import { NextResponse } from '@/server/http-compat';
import { ingestWireMessage, mailboxOf } from '@mantle/email';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { IngestBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  POST: { class: 'public', item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" } },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, IngestBody, { refuseEmpty: true });
  return asSidecar(async () => {
    const account = await mailboxOf(await sidecarOwner(), body.accountId);
    if (!account || !account.enabled) {
      return NextResponse.json({ error: 'no such mailbox' }, { status: 404 });
    }
    return NextResponse.json({ stored: await ingestWireMessage(account, body.message) });
  });
}
