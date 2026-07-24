/**
 * GET /api/team-admin/members?contact=<id>&apage=<n> — the Members tab's data,
 * serialized exactly as the old SSR page computed it: the roster LEFT-joined
 * to forum activity in memory (a freshly enabled member who never posted
 * still shows), most-recent-post-first, plus the selected member's activity
 * detail (posts+answers page, authored topics, filed requests, chat archive,
 * access log).
 *
 * Deliberately read-only: the SSR page used to advance the pre-Forum chat
 * cursor as a RENDER side effect — that moved to an explicit
 * POST /api/team-admin/members/[contactId]/thread-read, fired by the client
 * after the pane is actually on screen.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import {
  listTeamMemberActivity,
  listForumMemberActivity,
  listForumPostsByContact,
  countForumPostsByContact,
  listForumTopicsByAuthor,
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
  const apage = Math.max(1, Number.parseInt(url.searchParams.get('apage') ?? '1', 10) || 1);

  const [badges, roster, forumActivity] = await Promise.all([
    teamAdminBadges(user.id),
    listTeamMemberActivity(user.id),
    listForumMemberActivity(user.id),
  ]);
  const forumByContact = new Map(forumActivity.map((f) => [f.contactId, f]));
  const members = roster
    .map((m) => ({ ...m, forum: forumByContact.get(m.contactId) ?? null }))
    .sort((a, b) => {
      const aAt = a.forum?.lastPostAt ?? null;
      const bAt = b.forum?.lastPostAt ?? null;
      if (aAt && bAt) return bAt.localeCompare(aAt);
      if (aAt) return -1;
      if (bAt) return 1;
      return b.memberSince.localeCompare(a.memberSince);
    });

  const selectedId =
    contact && members.some((m) => m.contactId === contact)
      ? contact
      : (members[0]?.contactId ?? null);
  const selectedMember = members.find((m) => m.contactId === selectedId) ?? null;

  if (!selectedId || !selectedMember) {
    return NextResponse.json({ badges, members, selected: null });
  }

  const [posts, postTotal, authored, requests, thread, access] = await Promise.all([
    listForumPostsByContact(user.id, selectedId, {
      limit: ACTIVITY_PAGE_SIZE,
      offset: (apage - 1) * ACTIVITY_PAGE_SIZE,
    }),
    countForumPostsByContact(user.id, selectedId),
    listForumTopicsByAuthor(user.id, selectedId, { limit: 20 }),
    listTeamRequests(user.id, { status: 'all', limit: 50, contactId: selectedId }),
    // Only touch the frozen chat store when this member actually has an
    // archive — on a post-Forum brain that query would always return [].
    selectedMember.messageCount > 0
      ? listTeamThread(user.id, selectedId, { limit: ARCHIVE_SHOWN })
      : Promise.resolve([]),
    listTeamAccess(user.id, { contactId: selectedId, limit: 50 }),
  ]);

  // Dates (thread rows) serialize to ISO via JSON — the client types carry
  // strings end to end.
  return NextResponse.json({
    badges,
    members,
    selected: {
      contactId: selectedId,
      activityPage: apage,
      activityPageSize: ACTIVITY_PAGE_SIZE,
      posts,
      postTotal,
      authored,
      requests,
      thread,
      access,
    },
  });
}
