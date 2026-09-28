/**
 * GET /api/team-admin/members?contact=<id>: the Members tab's data: the
 * old portal chat roster (every contact with portal chat, newest activity
 * first) plus the selected contact's filed requests, old portal chat (the
 * "Chat archive") and access log.
 *
 * Team codes are retired (member logins Phase 6, migration 0178), so the
 * roster is driven by the chat, not by who holds a code. Each member row
 * keeps `tokenLastUsedAt` (always null) and `memberSince` (the first portal
 * message) one contract cycle for client builds that still read them.
 *
 * The forum parts are gone with the forum (member logins Phase 6: its
 * content lives on as the admin-level Forum archive pages). `forum`, `posts`,
 * `postTotal` and `authored` stay in the answer, always empty, one contract
 * cycle for client builds that still read them.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import {
  listTeamMemberActivity,
  listTeamRequests,
  listTeamThread,
  listTeamAccess,
} from '@mantle/content';
import { teamAdminBadges } from '@/lib/team-admin-overview';

const ACTIVITY_PAGE_SIZE = 25;
const ARCHIVE_SHOWN = 50;

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const contact = url.searchParams.get('contact') ?? undefined;

  const [badges, roster] = await Promise.all([
    teamAdminBadges(user.id),
    listTeamMemberActivity(user.id),
  ]);
  const members = roster.map((m) => ({ ...m, forum: null }));

  const selectedId =
    contact && members.some((m) => m.contactId === contact)
      ? contact
      : (members[0]?.contactId ?? null);
  const selectedMember = members.find((m) => m.contactId === selectedId) ?? null;

  if (!selectedId || !selectedMember) {
    return NextResponse.json({ badges, members, selected: null });
  }

  const [requests, thread, access] = await Promise.all([
    listTeamRequests(user.id, { status: 'all', limit: 50, contactId: selectedId }),
    listTeamThread(user.id, selectedId, { limit: ARCHIVE_SHOWN }),
    listTeamAccess(user.id, { contactId: selectedId, limit: 50 }),
  ]);

  // Dates (thread rows) serialize to ISO via JSON — the client types carry
  // strings end to end.
  return NextResponse.json({
    badges,
    members,
    selected: {
      contactId: selectedId,
      activityPage: 1,
      activityPageSize: ACTIVITY_PAGE_SIZE,
      posts: [],
      postTotal: 0,
      authored: [],
      requests,
      thread,
      access,
    },
  });
}
