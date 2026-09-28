/**
 * Member invites, admin side (member logins, Phase 6).
 *
 * GET  /api/team-admin/invites: open, redeemed and expired invites, newest
 *      first, never a code (MemberInviteList).
 * POST /api/team-admin/invites { contactId?, email?, displayName? }: mint an
 *      invite (MemberInviteCreated, 201). The contact must be a contact of
 *      this brain with no login; the email and name default to the
 *      contact's. 409 when a login already has the email or the contact.
 *      The plaintext code and the link path are in this response ONCE.
 *
 * Admin only: getOwnerOr401 refuses a member login (403 member-login).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { createMemberInvite, inviteLinkPath, listMemberInvites } from '@mantle/content';
import type { MemberInviteCreated, MemberInviteList } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { inviteErrorResponse } from '@/lib/member-invites';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const body: MemberInviteList = { invites: await listMemberInvites(user.id) };
  return NextResponse.json(body);
}

const CreateBody = z.object({
  contactId: z.string().uuid().optional(),
  email: z.string().trim().email().max(320).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Choose a contact or enter an email.' }, { status: 400 });
  }
  try {
    const { invite, code } = await createMemberInvite(user.id, {
      ...parsed.data,
      createdBy: user.actor.id,
    });
    const body: MemberInviteCreated = { invite, code, linkPath: inviteLinkPath(code) };
    return NextResponse.json(body, { status: 201 });
  } catch (err) {
    return inviteErrorResponse(err);
  }
}
