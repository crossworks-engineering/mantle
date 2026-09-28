/**
 * The member daily message budget. One cap per member per UTC day (env
 * TEAM_CHAT_DAILY_TURNS, default 100), so a leaked credential never becomes a
 * wallet drain. The member chat counts its inbound messages against it; the
 * team forum counted its posts against the same number until it closed.
 *
 * Lives here, not in a forum module, so the member chat keeps it when the
 * forum code is deleted (Phase 6).
 */
import { env } from '@mantle/config';

export const MEMBER_DAILY_CAP = (() => {
  const n = Number(env('TEAM_CHAT_DAILY_TURNS'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
})();

/** Midnight UTC today: where the daily budget window starts. */
export function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
