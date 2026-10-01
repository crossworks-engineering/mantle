/**
 * Client logins, admin side (client logins, Phase C2): Team admin > Clients.
 *
 * GET  /api/team-admin/clients: every client login with its open sign-in
 *      link (never a code), and whether "What clients see" is acknowledged
 *      (ClientLoginList).
 * POST /api/team-admin/clients { contactId?, email?, displayName? }: make a
 *      CLIENT login (ClientLoginCreated, 201). It has no password anyone
 *      knows: it signs in with a link (POST .../:id/signin-link). 409
 *      report-not-acknowledged until an admin has checked the report; 409
 *      when a login already has the email or the contact.
 *
 * End sessions, Disable and Delete are the users routes (PATCH and DELETE
 * /api/users/:id). POST /api/users never makes a client: clients are made
 * here only. Admin only: getOwnerOr401 refuses members and clients. These
 * routes write their own audit rows (AUDIT_SELF_LOGGED_PATHS).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { clientReportAcknowledged, createClientLogin, listClientLogins } from '@mantle/content';
import type { ClientLoginCreated, ClientLoginList } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { clientLoginErrorResponse, unusablePasswordHash } from '@/lib/client-logins';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [clients, reportAcknowledged] = await Promise.all([
    listClientLogins(user.id),
    clientReportAcknowledged(user.id),
  ]);
  const body: ClientLoginList = { clients, reportAcknowledged };
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
    const client = await createClientLogin(user.id, {
      ...parsed.data,
      unusablePasswordHash: await unusablePasswordHash(),
      createdBy: user.actor.id,
    });
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action: 'user.create',
      method: 'POST',
      path: '/api/team-admin/clients',
      detail: { targetId: client.id, targetEmail: client.email, role: 'client' },
      ...requestMetaFrom(req),
    });
    const body: ClientLoginCreated = { client };
    return NextResponse.json(body, { status: 201 });
  } catch (err) {
    return clientLoginErrorResponse(err);
  }
}
