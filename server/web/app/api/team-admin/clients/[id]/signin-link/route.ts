/**
 * A client login's sign-in link (client logins, Phase C2).
 *
 * POST   /api/team-admin/clients/:id/signin-link: issue a link, 72 hours,
 *        one use (ClientSigninLinkCreated, 201). The code and the path are
 *        in this response ONCE. The login's older open links are revoked.
 *        409 report-not-acknowledged until "What clients see" is checked;
 *        404 when the login is not an active client.
 * DELETE /api/team-admin/clients/:id/signin-link: revoke the open link.
 *        404 when there is none.
 *
 * Admin only: getOwnerOr401 refuses members and clients.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import {
  clientSigninLinkPath,
  issueClientSigninLink,
  revokeClientSigninLink,
} from '@mantle/content';
import type { ClientSigninLinkCreated } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientLoginErrorResponse } from '@/lib/client-logins';

const Params = z.object({ id: z.string().uuid() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  try {
    const { link, code } = await issueClientSigninLink(user.id, params.data.id, user.actor.id);
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action: 'client.signin_link_issued',
      method: 'POST',
      path: `/api/team-admin/clients/${params.data.id}/signin-link`,
      detail: { targetId: params.data.id, linkId: link.id },
      ...requestMetaFrom(req),
    });
    const body: ClientSigninLinkCreated = { link, code, path: clientSigninLinkPath(code) };
    return NextResponse.json(body, { status: 201 });
  } catch (err) {
    return clientLoginErrorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success || !(await revokeClientSigninLink(user.id, params.data.id))) {
    return NextResponse.json({ error: 'No open sign-in link.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
