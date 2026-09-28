/**
 * The team forum is closed (member logins, Phase 6). Team contacts become
 * member logins through invites (docs/member-logins.md section 9), and the
 * forum's content lives on as the admin-level "Forum archive" pages
 * (docs/team-forum.md).
 *
 * Every write that would add to the forum answers this 410: a new topic, a
 * reply, an admin post and a staged upload (an upload only exists to be
 * posted). Reads stay open until the forum code is deleted. The check runs
 * AFTER the caller's credential is resolved, so an anonymous or wrong-kind
 * caller still gets its usual 401/403 and the auth sweeps hold.
 *
 * `enqueueForumTurn` refuses too (ForumClosedError), so no path can start a
 * new forum turn. A turn already queued before the freeze may finish.
 */
import { NextResponse } from '@/server/http-compat';

/** Always true: there is no switch to reopen the forum. It is a typed
 *  constant (not a bare `return`) so the write code after each check stays
 *  valid until the deletion stage removes it with the rest of the forum. */
export const FORUM_CLOSED: boolean = true;

export const FORUM_CLOSED_REASON = 'forum-closed';

export const FORUM_CLOSED_MESSAGE =
  'The team forum is closed. Team members use their own logins now.';

export const FORUM_CLOSED_INVITE_HINT =
  'Ask the brain admin for an invite link: it sets up your own login, where you chat with the team agent and share files.';

export type ForumClosedBody = {
  error: string;
  reason: typeof FORUM_CLOSED_REASON;
  inviteHint: string;
};

/** The one answer every forum write gives now. */
export function forumClosedResponse(): Response {
  const body: ForumClosedBody = {
    error: FORUM_CLOSED_MESSAGE,
    reason: FORUM_CLOSED_REASON,
    inviteHint: FORUM_CLOSED_INVITE_HINT,
  };
  return NextResponse.json(body, { status: 410 });
}

/** Thrown by `enqueueForumTurn`: the forum takes no new turns. */
export class ForumClosedError extends Error {
  readonly reason = FORUM_CLOSED_REASON;
  constructor() {
    super(FORUM_CLOSED_MESSAGE);
    this.name = 'ForumClosedError';
  }
}
