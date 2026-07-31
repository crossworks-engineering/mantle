/**
 * GET /api/team-portal — the roster, and nothing else.
 *
 * /team-admin already serves members, but bundled with forum activity, the
 * request queue, the chat archive and the access log, because that screen is
 * for reading what the team has been doing. The Team Portal signpost only
 * needs "who currently holds a token, and has it ever been used" — so it gets
 * its own thin route rather than paying for the admin bundle on a page whose
 * job is mostly explanation.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listTeamMemberActivity } from '@mantle/content';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const roster = await listTeamMemberActivity(user.id);

  return NextResponse.json({
    members: roster.map((m) => ({
      contactId: m.contactId,
      contactName: m.contactName,
      memberSince: m.memberSince,
      // The one field that answers "did the token actually work for them?" —
      // null means minted but never redeemed, which is the usual reason a
      // member reports they can't get in.
      tokenLastUsedAt: m.tokenLastUsedAt,
    })),
  });
}
