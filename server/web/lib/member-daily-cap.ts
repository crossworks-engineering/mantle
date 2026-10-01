/**
 * The member daily budget, per member login per UTC day (audit F09):
 *
 *   - MEMBER_DAILY_CAP turns (env TEAM_CHAT_DAILY_TURNS, default 100), counted
 *     from the turn ledger written when a turn is queued;
 *   - MEMBER_DAILY_TOKENS model tokens, in plus out (env
 *     MANTLE_MEMBER_DAILY_TOKENS, default 2,000,000; 0 turns it off), summed
 *     from the login's member chat traces.
 *
 * So a leaked credential or a runaway client never becomes a wallet drain.
 * Both are checked before a turn is queued (packages/content member-turn-ledger.ts).
 */
import { env } from '@mantle/config';

export const MEMBER_DAILY_CAP = (() => {
  const n = Number(env('TEAM_CHAT_DAILY_TURNS'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
})();

/** The default token budget: room for dozens of tool-heavy turns a day. */
export const MEMBER_DAILY_TOKENS_DEFAULT = 2_000_000;

export const MEMBER_DAILY_TOKENS = (() => {
  const raw = env('MANTLE_MEMBER_DAILY_TOKENS');
  if (raw === undefined || raw === '') return MEMBER_DAILY_TOKENS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MEMBER_DAILY_TOKENS_DEFAULT;
})();

/** Midnight UTC today: where the daily budget window starts. */
export function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
