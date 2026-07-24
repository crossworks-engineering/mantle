/**
 * Forum cost-guard helpers shared by the topic-create and post-create routes.
 * One DAILY budget covers the whole team surface: team-chat turns + forum
 * posts count against the same cap (env TEAM_CHAT_DAILY_TURNS, default 100)
 * — a leaked 8-char token must never become a wallet drain, and moving the
 * conversation from chat to forum must not double the budget.
 */
import { countForumMemberPostsSince, countTeamInboundSince } from '@mantle/content';

export const FORUM_DAILY_CAP = (() => {
  const n = Number(process.env.TEAM_CHAT_DAILY_TURNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
})();

/** Per-member daily upload budget in bytes (forum attachments). Separate from
 *  the turn cap — bytes and turns exhaust different resources (disk vs
 *  wallet). Env TEAM_UPLOAD_DAILY_BYTES, default 100 MB. */
export const UPLOAD_DAILY_BYTES = (() => {
  const n = Number(process.env.TEAM_UPLOAD_DAILY_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100 * 1024 * 1024;
})();

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Today's spend against the shared budget: team-chat inbound + forum posts. */
export async function forumDailySpend(ownerId: string, contactId: string): Promise<number> {
  const since = startOfTodayUtc();
  const [chat, forum] = await Promise.all([
    countTeamInboundSince(ownerId, contactId, since),
    countForumMemberPostsSince(ownerId, contactId, since),
  ]);
  return chat + forum;
}
