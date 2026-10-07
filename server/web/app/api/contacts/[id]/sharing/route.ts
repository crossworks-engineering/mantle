/**
 * POST /api/contacts/:id/sharing { action: 'enable' | 'regenerate' | 'disable' }
 * (contact shares, migration 0214; docs/contacts.md "Sharing"). Admins only.
 *
 *  - enable: a code, shown ONCE in the answer (`code`). 409 when sharing is
 *    already on (use regenerate).
 *  - regenerate: a new code, shown once; the old one and every visitor
 *    cookie of the contact stop at once, and a lock is cleared.
 *  - disable: the code goes and every live share of the contact is revoked
 *    in the same transaction (decision 3); `revoked` says how many.
 *
 * Every answer carries the contact's `sharing` after the change.
 */
import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import {
  contactSharingFor,
  disableContactSharing,
  enableContactSharing,
  regenerateContactCode,
} from '@mantle/content';
import type { ContactSharingResponse } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { getContact } from '@/lib/contacts';

const Body = z.object({ action: z.enum(['enable', 'regenerate', 'disable']) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid action' }, { status: 400 });
  if (!(await getContact(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const { action } = parsed.data;
  const audit = (what: 'enabled' | 'regenerated' | 'disabled', detail: Record<string, unknown>) =>
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action: `contact.sharing_${what}`,
      method: 'POST',
      path: '/api/contacts/:id/sharing',
      detail: { contactId: id, ...detail },
      ...requestMetaFrom(req),
    });

  if (action === 'enable') {
    const r = await enableContactSharing(user.id, id);
    if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if ('alreadyOn' in r) {
      return NextResponse.json(
        { error: 'Sharing is already on. Regenerate the code instead.', reason: 'already-on' },
        { status: 409 },
      );
    }
    audit('enabled', {});
    return NextResponse.json(
      {
        code: r.code,
        sharing: await contactSharingFor(user.id, id),
      } satisfies ContactSharingResponse,
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  if (action === 'regenerate') {
    const r = await regenerateContactCode(user.id, id);
    if (!r) {
      return NextResponse.json(
        { error: 'Sharing is off for this contact.', reason: 'sharing-off' },
        { status: 409 },
      );
    }
    audit('regenerated', {});
    return NextResponse.json(
      {
        code: r.code,
        sharing: await contactSharingFor(user.id, id),
      } satisfies ContactSharingResponse,
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const r = await disableContactSharing(user.id, id);
  if (r) audit('disabled', { revoked: r.revoked });
  return NextResponse.json({
    sharing: null,
    revoked: r?.revoked ?? 0,
  } satisfies ContactSharingResponse);
}
