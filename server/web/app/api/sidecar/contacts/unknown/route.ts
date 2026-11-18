/**
 * POST /api/sidecar/contacts/unknown (Sync service plan M2): for the Sync
 * sidecar's discover screen. Of the sender addresses it saw in the owner's
 * mailboxes, the ones the contacts gate does not allow (not yet a contact).
 */
import { NextResponse } from '@/server/http-compat';
import { loadContactGate } from '@mantle/content';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { UnknownSendersBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  POST: { class: 'public', item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" } },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const body = await readBody(req, UnknownSendersBody, { refuseEmpty: true });
  return asSidecar(async () => {
    const gate = await loadContactGate(await sidecarOwner());
    return NextResponse.json({ unknown: body.addresses.filter((a) => !gate.allows(a)) });
  });
}
