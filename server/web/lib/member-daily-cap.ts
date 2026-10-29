/**
 * The member daily budget, per member login per UTC day:
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
import { envNum, envNumDefault } from '@mantle/config';

export const MEMBER_DAILY_CAP = envNum('TEAM_CHAT_DAILY_TURNS');

/** The default token budget: room for dozens of tool-heavy turns a day. */
export const MEMBER_DAILY_TOKENS_DEFAULT = envNumDefault('MANTLE_MEMBER_DAILY_TOKENS');

export const MEMBER_DAILY_TOKENS = envNum('MANTLE_MEMBER_DAILY_TOKENS');

/** Midnight UTC today: where the daily budget window starts. */
export function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Seconds until the daily budget opens again (the next midnight UTC), at
 *  least 1: the Retry-After of a daily-cap 429 (every 429 says when to
 *  come back). */
export function secondsUntilTomorrowUtc(): number {
  const next = startOfTodayUtc().getTime() + 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((next - Date.now()) / 1000));
}
