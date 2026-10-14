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
import { createContactShares } from '@mantle/content';
import type { CreateContactSharesResponse } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readBody } from '@/lib/read-body';

const Body = z.object({
  nodeId: z.string().uuid(),
  contactIds: z.array(z.string().uuid()).min(1).max(100),
  canWrite: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, Body);
  // A refused share (ContactShareRefusedError) answers 400 with its reason
  // by the one table (A10 part 2).
  const shares = await createContactShares(
    user.id,
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
