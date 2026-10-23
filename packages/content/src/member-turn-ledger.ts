/**
 * The member chat's cost limits (audit F09): a per-login ledger written when a
 * turn is QUEUED, and a per-login daily token budget.
 *
 * Before this, the daily cap counted the inbound `team_messages` rows the turn
 * workflow writes once it runs, so turns waiting on a busy queue were not
 * counted and a member could pass the cap. `claimMemberTurn` runs at enqueue
 * time, in one transaction under a per-login advisory lock, so two sends at
 * once cannot both take the last slot:
 *
 *   - a turn id already in the ledger (a retry with the same Idempotency-Key)
 *     is the same turn: admitted, not counted again, and not re-checked (a
 *     retry of a turn that was queued must not be refused afterwards);
 *   - otherwise the login's turns since midnight UTC are counted against the
 *     cap, and its `responder_turn` tokens since then against the budget;
 *   - an admitted turn is written, so it counts from this moment.
 *
 * The token budget reads the ledger's own tokens: a turn's model tokens are
 * stamped on its slot when its trace closes (settleMemberTurn, migration
 * 0326), so the budget can be passed by the turns already queued (at most the
 * 6-a-minute limit's worth). It is a brake on a runaway, not an invoice. It
 * never reads the traces: the narrow login writes those, not the ledger.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { loginDefinerCall, systemDb, traces } from '@mantle/db';
import { envNum } from '@mantle/config';

export type MemberTurnLimits = {
  /** Turns per UTC day. */
  dailyTurns: number;
  /** Model tokens (in + out) per UTC day; 0 = no token budget. */
  dailyTokens: number;
};

export type ClaimMemberTurnResult =
  | { ok: true; fresh: boolean }
  | { ok: false; reason: 'daily_cap'; used: number }
  | { ok: false; reason: 'token_budget'; used: number };

/**
 * The member daily limits from the environment: TEAM_CHAT_DAILY_TURNS turns
 * (default 100) and MANTLE_MEMBER_DAILY_TOKENS tokens (default 2,000,000; 0
 * turns the budget off). The same reading as server/web
 * lib/member-daily-cap.ts, for a path outside the web tier: a Telegram turn
 * of a login that is not an Admin user (workspaces W7d).
 */
export function memberDailyLimits(): MemberTurnLimits {
  return {
    dailyTurns: envNum('TEAM_CHAT_DAILY_TURNS'),
    dailyTokens: envNum('MANTLE_MEMBER_DAILY_TOKENS'),
  };
}

/** Tokens (in + out) of this login's member chat turns since `since`, as
 *  their `responder_turn` traces recorded them (run-team-turn.ts stamps
 *  `login_id`). A record to show, never the budget: the budget sums the
 *  ledger's tokens (settleMemberTurn), which no narrow session can change. */
export async function memberTokensSince(
  ownerId: string,
  loginId: string,
  since: Date,
): Promise<number> {
  const [row] = await systemDb
    .select({
      n: sql<string>`coalesce(sum(${traces.tokensIn} + ${traces.tokensOut}), 0)::bigint`,
    })
    .from(traces)
    .where(
      and(
        eq(traces.ownerId, ownerId),
        eq(traces.kind, 'responder_turn'),
        gte(traces.startedAt, since),
        eq(traces.subjectKind, 'team_turn'),
        sql`${traces.data}->>'login_id' = ${loginId}`,
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Admit a member chat turn and write it to the ledger, or refuse it with the
 * limit it would pass. Call BEFORE the turn is enqueued; on an enqueue that
 * fails, `releaseMemberTurn` gives the slot back.
 *
 * The whole claim is one definer call (mantle_member_turn_claim, migration
 * 0325) in `loginId`'s own scope on the system pool (loginDefinerCall): the
 * definer takes the login from that scope, never as an argument, under the
 * per-login lock, so two sends at once cannot both take the last slot. The
 * narrow role holds no right on the ledger and may not run the definers.
 */
export async function claimMemberTurn(args: {
  ownerId: string;
  loginId: string;
  turnId: string;
  since: Date;
  limits: MemberTurnLimits;
}): Promise<ClaimMemberTurnResult> {
  const { ownerId, loginId, turnId, since, limits } = args;
  const rows = await loginDefinerCall<{
    ok: boolean;
    fresh: boolean;
    reason: string | null;
    used: string | null;
  }>(
    loginId,
    'own',
    sql`select ok, fresh, reason, used from mantle_member_turn_claim(${turnId}::text,
        ${ownerId}::uuid, ${since.toISOString()}::timestamptz, ${limits.dailyTurns}::integer,
        ${limits.dailyTokens}::bigint)`,
  );
  const r = rows[0];
  if (!r) throw new Error('claimMemberTurn: the claim answered nothing');
  if (r.ok) return { ok: true, fresh: r.fresh };
  const used = Number(r.used ?? 0);
  return r.reason === 'token_budget'
    ? { ok: false, reason: 'token_budget', used }
    : { ok: false, reason: 'daily_cap', used };
}

/** Give a claimed slot back: the enqueue it was claimed for failed. Only
 *  `loginId`'s own row, and only one claimed in the last five minutes
 *  (mantle_member_turn_release, 0325). */
export async function releaseMemberTurn(loginId: string, turnId: string): Promise<void> {
  await loginDefinerCall(loginId, 'own', sql`select mantle_member_turn_release(${turnId}::text)`);
}

/** Stamp a member chat turn's model tokens (in + out) on its slot, at the
 *  turn's close: only `loginId`'s own row with that id, only up
 *  (mantle_member_turn_settle, 0326). The token budget sums these. False
 *  when the login holds no such slot (an Admin user's turn takes none). */
export async function settleMemberTurn(
  loginId: string,
  turnId: string,
  tokens: number,
): Promise<boolean> {
  const n = Math.max(0, Math.floor(tokens));
  const rows = await loginDefinerCall<{ hit: boolean }>(
    loginId,
    'own',
    sql`select mantle_member_turn_settle(${turnId}::text, ${n}::bigint) as hit`,
  );
  return rows[0]?.hit === true;
}
