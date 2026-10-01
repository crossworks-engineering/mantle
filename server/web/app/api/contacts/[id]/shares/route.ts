/**
 * A contact's "Shared" tab (contact shares, migration 0214). Admins only.
 *
 * GET /api/contacts/:id/shares?cursor= : the contact's live shares, newest
 * first, 100 a page (`nextCursor` null on the last). `lastOpenedAt` is when
 * the contact last opened the item. A single Revoke on the tab is
 * DELETE /api/shares/:id, the same call the item's share dialog makes.
 *
 * DELETE /api/contacts/:id/shares : Revoke all. Every live share of this
 * contact, in one statement; no level changes; sharing stays on (the code
 * still works for new shares). Answers `{ revoked }`.
 */
import { NextResponse } from '@/server/http-compat';
import { listContactSharesForAdmin, revokeAllContactShares } from '@mantle/content';
import type { ContactSharesPage, ContactSharesRevokedAll } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { getContact } from '@/lib/contacts';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!(await getContact(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const cursor = new URL(req.url).searchParams.get('cursor');
  const page = await listContactSharesForAdmin(user.id, id, cursor);
  return NextResponse.json(page satisfies ContactSharesPage);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!(await getContact(user.id, id))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const revoked = await revokeAllContactShares(user.id, id);
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'contact.shares_revoked_all',
    method: 'DELETE',
    path: '/api/contacts/:id/shares',
    detail: { contactId: id, revoked },
    ...requestMetaFrom(req),
  });
  return NextResponse.json({ revoked } satisfies ContactSharesRevokedAll);
}
