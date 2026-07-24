/**
 * POST /api/contacts/[id]/team — manage a contact's team-member role.
 *
 * Actions:
 *   enable  → grant the role, mint the token. Response carries the PLAINTEXT
 *             token — the only time it crosses the wire; only its hash is
 *             stored. The UI shows it once for the operator to hand over.
 *   rotate  → re-mint an existing member's token (lost/compromised). 404 on
 *             non-members — rotation never silently enrolls.
 *   disable → revoke the role; the token dies with it.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { disableTeamMember, enableTeamMember, rotateTeamToken } from '@mantle/content';

const Body = z.object({ action: z.enum(['enable', 'rotate', 'disable']) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });

  switch (parsed.data.action) {
    case 'enable': {
      const minted = await enableTeamMember(user.id, id);
      if (!minted) return NextResponse.json({ error: 'not found' }, { status: 404 });
      // Already a member — enable never silently rotates a live token; the
      // operator must use 'rotate' for a deliberate re-mint.
      if ('alreadyMember' in minted) {
        return NextResponse.json(
          { error: 'already a team member — use rotate to re-issue their token' },
          { status: 409 },
        );
      }
      return NextResponse.json({ token: minted.token });
    }
    case 'rotate': {
      const minted = await rotateTeamToken(user.id, id);
      if (!minted) {
        return NextResponse.json({ error: 'not a team member' }, { status: 404 });
      }
      return NextResponse.json({ token: minted.token });
    }
    case 'disable': {
      const ok = await disableTeamMember(user.id, id);
      if (!ok) return NextResponse.json({ error: 'not a team member' }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
  }
}
