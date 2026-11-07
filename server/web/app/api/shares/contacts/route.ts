/**
 * POST /api/shares/contacts { nodeId, contactIds[], canWrite? } (contact
 * shares, migration 0214): share one item with one or more contacts. One
 * share per contact, each with its own link (`path`, `/s/<token>`), opened
 * with that contact's code. Idempotent per item and contact. Changes no
 * level: the team never sees the item. Admins only. Audited
 * (`contact.share_created`).
 *
 * 400 `{ error, reason }` when refused: a contact with sharing off
 * (`sharing-off`), not a contact of this brain (`not-a-contact`), a folder
 * (`folder`, not in v1), a kind that is not a workspace item
 * (`not-shareable`), `canWrite` on anything but an app (`write-not-app`).
 */
import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import { adminCreateContactShares } from '@mantle/content';
import type { CreateContactSharesResponse } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readBody } from '@/lib/read-body';
import { loginOwnedByAnother } from '@/lib/shares';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: {
      none: 'a contact share: the item is named in the body, not the path; the handler asks its right',
    },
  },
});

const Body = z.object({
  nodeId: z.string().uuid(),
  contactIds: z.array(z.string().uuid()).min(1).max(100),
  canWrite: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, Body);
  // The item read in the caller's scope first: another login's own item
  // (nodes.login_id) is a 404 with no detail, nothing shared. Its home
  // stays unchecked (an Admin user shares an item of any workspace with a
  // contact, the rule s6-c1-admin-acts.db.test.ts pins), so the read asks
  // only whose own the item is; the Admin act's definer refuses another
  // login's own item whatever the scope reads (0366).
  if (await loginOwnedByAnother(body.nodeId, user.actor.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  // A refused share (ContactShareRefusedError) answers 400 with its reason
  // by the one table. An Admin act: the definer mantle_share_with_contacts
  // checks the Admin user inside (migration 0308); the item's home is not
  // checked.
  const shares = await adminCreateContactShares(
    user.actor.id,
    body.nodeId,
    body.contactIds,
    body.canWrite === true,
  );
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'contact.share_created',
    method: 'POST',
    path: '/api/shares/contacts',
    detail: {
      nodeId: body.nodeId,
      contactIds: shares.map((s) => s.contactId),
      canWrite: body.canWrite === true,
    },
    ...requestMetaFrom(req),
  });
  return NextResponse.json({ shares } satisfies CreateContactSharesResponse);
}
