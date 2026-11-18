/**
 * POST /api/sidecar/contacts (Sync service plan M2): the discover screen's
 * "Add as contact", from the Sync sidecar. The normal contact create (the
 * person chose the sender on the screen); its new address starts the
 * sender's 90-day backfill, as any new contact does.
 */
import { NextResponse } from '@/server/http-compat';
import { createContact } from '@mantle/content';
import { enqueueBackfills } from '@mantle/email';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { AddContactBody } from '@/lib/sidecar-schemas';
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
  const body = await readBody(req, AddContactBody, { refuseEmpty: true });
  return asSidecar(async () => {
    const owner = await sidecarOwner();
    const address = body.address.trim().toLowerCase();
    const name = (body.name ?? '').trim();
    const [firstName, ...rest] = (name || address.split('@')[0] || address).split(/\s+/);
    const { contact, addedEmails } = await createContact(owner, {
      firstName: firstName || undefined,
      lastName: rest.join(' ') || undefined,
      emails: [address],
      tags: [],
    });
    void enqueueBackfills(owner, addedEmails);
    return NextResponse.json({ id: contact.id });
  });
}
