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
import { adminContactSharing, contactSharingFor } from '@mantle/content';
import type { ContactSharingResponse } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    item: {
      none: 'a contact, an Admin-only kind: no workspace item; only an Admin user reaches the route, in the Admin scope',
    },
  },
});

const Body = z.object({ action: z.enum(['enable', 'regenerate', 'disable']) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'invalid action' }, { status: 400 });
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

  // An Admin act: the definer mantle_contact_sharing_set checks the Admin
  // user and the contact inside (migration 0308).
  const r = await adminContactSharing(user.actor.id, id, action);
  if (r.outcome === 'not-a-contact') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (action === 'enable') {
    if (r.outcome === 'already-on' || r.code === null) {
      return NextResponse.json(
        { error: 'Sharing is already on. Regenerate the code instead.', reason: 'already-on' },
        { status: 409 },
      );
    }
    audit('enabled', {});
    return NextResponse.json({
      code: r.code,
      sharing: await contactSharingFor(user.id, id),
    } satisfies ContactSharingResponse);
  }
  if (action === 'regenerate') {
    if (r.code === null) {
      return NextResponse.json(
        { error: 'Sharing is off for this contact.', reason: 'sharing-off' },
        { status: 409 },
      );
    }
    audit('regenerated', {});
    return NextResponse.json({
      code: r.code,
      sharing: await contactSharingFor(user.id, id),
    } satisfies ContactSharingResponse);
  }
  const off = r.outcome === 'off';
  if (off) audit('disabled', { revoked: r.revoked });
  return NextResponse.json({
    sharing: null,
    revoked: off ? r.revoked : 0,
  } satisfies ContactSharingResponse);
}
