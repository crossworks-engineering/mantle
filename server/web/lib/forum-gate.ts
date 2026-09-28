/**
 * Forum cost-guard helpers shared by the topic-create and post-create routes.
 * One DAILY budget per team-code member: forum posts count against the cap
 * (env TEAM_CHAT_DAILY_TURNS, default 100), so a leaked 8-char token never
 * becomes a wallet drain. The member chat (a login) uses the same cap, which
 * lives in member-daily-cap.ts.
 */
import { countForumMemberPostsSince } from '@mantle/content';
import { env } from '@mantle/config';
import { MEMBER_DAILY_CAP, startOfTodayUtc } from './member-daily-cap';

/** The shared member cap (lib/member-daily-cap.ts), under its forum name. */
export const FORUM_DAILY_CAP = MEMBER_DAILY_CAP;

/** Per-member daily upload budget in bytes (forum attachments). Separate from
 *  the turn cap — bytes and turns exhaust different resources (disk vs
 *  wallet). Env TEAM_UPLOAD_DAILY_BYTES, default 100 MB. */
export const UPLOAD_DAILY_BYTES = (() => {
  const n = Number(env('TEAM_UPLOAD_DAILY_BYTES'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100 * 1024 * 1024;
})();

/** Today's spend against the daily budget: the member's forum posts. The
 *  old team-code chat that also counted here is gone. */
export async function forumDailySpend(ownerId: string, contactId: string): Promise<number> {
  return countForumMemberPostsSince(ownerId, contactId, startOfTodayUtc());
}
