/**
 * POST /api/sidecar/mail/accounts (Sync service plan M2; lib/sidecar.ts):
 * the Sync sidecar linked or changed a mailbox. Makes or updates the
 * mailbox row its mail lands under (no credential: the sidecar keeps those
 * sealed in its state) and answers its id. An address the owner had before
 * gets its old row back, so its stored mail stays linked.
 */
import { NextResponse } from '@/server/http-compat';
import { saveMailbox } from '@mantle/email';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { MailboxBody } from '@/lib/sidecar-schemas';
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
  const body = await readBody(req, MailboxBody, { refuseEmpty: true });
  const id = await asSidecar(async () => saveMailbox(await sidecarOwner(), body));
  return NextResponse.json({ id });
}
