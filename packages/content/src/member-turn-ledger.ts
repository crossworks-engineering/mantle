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
 * The token budget reads finished traces: a turn's tokens land when its trace
 * closes, so the budget can be passed by the turns already queued (at most the
 * 6-a-minute limit's worth). It is a brake on a runaway, not an invoice.
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { authUsers, memberTurnLedger, systemDb, traces } from '@mantle/db';

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

/** How long ledger rows are kept: well past the one day the cap reads. */
const LEDGER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Tokens (in + out) of this login's member chat turns since `since`, from
 *  their `responder_turn` traces (run-team-turn.ts stamps `login_id`). */
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
 */
export async function claimMemberTurn(args: {
  ownerId: string;
  loginId: string;
  turnId: string;
  since: Date;
  limits: MemberTurnLimits;
}): Promise<ClaimMemberTurnResult> {
  const { ownerId, loginId, turnId, since, limits } = args;
  return systemDb.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`member-turn:${loginId}`}, 0))`,
    );
    const [seen] = await tx
      .select({ turnId: memberTurnLedger.turnId })
      .from(memberTurnLedger)
      .where(eq(memberTurnLedger.turnId, turnId))
      .limit(1);
    if (seen) return { ok: true as const, fresh: false };

    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memberTurnLedger)
      .where(and(eq(memberTurnLedger.loginId, loginId), gte(memberTurnLedger.createdAt, since)));
    const used = counted?.n ?? 0;
    if (used >= limits.dailyTurns) return { ok: false as const, reason: 'daily_cap', used };

    if (limits.dailyTokens > 0) {
      const tokens = await memberTokensSince(ownerId, loginId, since);
      if (tokens >= limits.dailyTokens) {
        return { ok: false as const, reason: 'token_budget', used: tokens };
      }
    }

    await tx.insert(memberTurnLedger).values({ turnId, ownerId, loginId }).onConflictDoNothing();
    // Housekeeping on the login's own rows: the cap reads one day.
    await tx
      .delete(memberTurnLedger)
      .where(
        and(
          eq(memberTurnLedger.loginId, loginId),
          lt(memberTurnLedger.createdAt, new Date(Date.now() - LEDGER_KEEP_MS)),
        ),
      );
    return { ok: true as const, fresh: true };
  }) as Promise<ClaimMemberTurnResult>;
}

/** Give a claimed slot back: the enqueue it was claimed for failed. */
export async function releaseMemberTurn(turnId: string): Promise<void> {
  await systemDb.delete(memberTurnLedger).where(eq(memberTurnLedger.turnId, turnId));
}

/**
 * Each CLIENT login's chat use since `since` (client logins C4, the budget
 * card in Team admin > Clients): turns from the ledger (counted when queued)
 * and model tokens from the finished client turns' traces. Logins with no use
 * are absent. Admin read, on the admin pool.
 */
export async function clientChatUsageSince(
  ownerId: string,
  since: Date,
): Promise<Map<string, { turns: number; tokens: number }>> {
  const [turnRows, tokenRows] = await Promise.all([
    systemDb
      .select({ loginId: memberTurnLedger.loginId, n: sql<number>`count(*)::int` })
      .from(memberTurnLedger)
      .innerJoin(authUsers, eq(authUsers.id, memberTurnLedger.loginId))
      .where(
        and(
          eq(memberTurnLedger.ownerId, ownerId),
          gte(memberTurnLedger.createdAt, since),
          eq(authUsers.role, 'client'),
        ),
      )
      .groupBy(memberTurnLedger.loginId),
    systemDb
      .select({
        loginId: sql<string>`${traces.data}->>'login_id'`,
        n: sql<string>`coalesce(sum(${traces.tokensIn} + ${traces.tokensOut}), 0)::bigint`,
      })
      .from(traces)
      .where(
        and(
          eq(traces.ownerId, ownerId),
          eq(traces.kind, 'responder_turn'),
          gte(traces.startedAt, since),
          eq(traces.subjectKind, 'team_turn'),
          sql`${traces.data}->>'login_role' = 'client'`,
        ),
      )
      .groupBy(sql`${traces.data}->>'login_id'`),
  ]);
  const out = new Map<string, { turns: number; tokens: number }>();
  for (const r of turnRows) out.set(r.loginId, { turns: r.n, tokens: 0 });
  for (const r of tokenRows) {
    if (!r.loginId) continue;
    const cur = out.get(r.loginId) ?? { turns: 0, tokens: 0 };
    out.set(r.loginId, { ...cur, tokens: Number(r.n) });
  }
  return out;
}
