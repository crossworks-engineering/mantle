/**
 * The agent UI channel's calls (migration 0363, docs/agent-ui.md). A ui_*
 * tool opens a call (openUiCall) and waits for its row; the window answers it
 * once (answerUiCall, the result route); a Stop gives up the turn's open
 * calls (expireTurnUiCalls). Every write is through systemDb (the access
 * matrix: INSERT, and UPDATE of status, result and answered_at): a login's
 * scoped role never writes the table, it reads its own rows only.
 *
 * The rights live in the WHERE of the answer: the row must be this turn's,
 * this login's and this window's, pending and not expired, so a guessed
 * call id of another login, another turn or another window changes nothing,
 * and an expired call is never answered (whatever the sweep).
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { systemDb } from './gateway/handles';
import { uiCalls, type UiCallRow } from './schema/ui-calls';

/** The NOTIFY channel an answer (or a Stop) is announced on, its payload the
 *  call id: the process whose tool waits LISTENs and wakes its wait. A plain
 *  string literal, safe for pg_notify. */
export const UI_RESULT_CHANNEL = 'ui_result';

/** One call, as the tool opens it. */
export type OpenUiCall = Readonly<{
  turnId: string;
  loginId: string;
  windowId: string;
  /** The turn id and the tool call's id: the same step re-run finds its row. */
  stepKey: string;
  action: string;
  args: Record<string, unknown>;
  ttlMs: number;
}>;

/** Open a call, or find the one this step opened before (a DBOS re-run of
 *  the step: `created` false, and the row as it is now). */
export async function openUiCall(c: OpenUiCall): Promise<{ row: UiCallRow; created: boolean }> {
  const [inserted] = await systemDb
    .insert(uiCalls)
    .values({
      turnId: c.turnId,
      loginId: c.loginId,
      windowId: c.windowId,
      stepKey: c.stepKey,
      action: c.action,
      args: c.args,
      expiresAt: sql`now() + make_interval(secs => ${c.ttlMs / 1000})`,
    })
    .onConflictDoNothing({ target: uiCalls.stepKey })
    .returning();
  if (inserted) return { row: inserted, created: true };
  const [existing] = await systemDb
    .select()
    .from(uiCalls)
    .where(and(eq(uiCalls.stepKey, c.stepKey), eq(uiCalls.loginId, c.loginId)))
    .limit(1);
  if (!existing) throw new Error(`ui call ${c.stepKey}: the step's row is another login's`);
  return { row: existing, created: false };
}

/** A call's row, or null (not a uuid, or no such row). */
export async function readUiCall(id: string): Promise<UiCallRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await systemDb.select().from(uiCalls).where(eq(uiCalls.id, id)).limit(1);
  return row ?? null;
}

/** What the window asked to answer. */
export type UiAnswer = Readonly<{
  callId: string;
  turnId: string;
  loginId: string;
  windowId: string;
  result: Record<string, unknown>;
}>;

/** How an answer went: `done`, or why it changed nothing. `not_found` says
 *  nothing about which part did not match (another login's call, another
 *  turn's, another window's, or none at all). */
export type UiAnswerOutcome = 'done' | 'not_found' | 'answered' | 'expired';

/** Why an answer that updated no row changed nothing, from the row as it is
 *  (null: none). The answer's own WHERE is the rule; this only words it. */
export function uiAnswerMiss(
  row: Pick<UiCallRow, 'turnId' | 'loginId' | 'windowId' | 'status'> | null,
  a: Pick<UiAnswer, 'turnId' | 'loginId' | 'windowId'>,
): Exclude<UiAnswerOutcome, 'done'> {
  if (!row || row.turnId !== a.turnId || row.loginId !== a.loginId || row.windowId !== a.windowId) {
    return 'not_found';
  }
  return row.status === 'done' ? 'answered' : 'expired';
}

/** Answer a call once: the row must be this turn's, this login's and this
 *  window's, pending and not past expires_at. Then status done, the result,
 *  and NOTIFY UI_RESULT_CHANNEL with the call id. */
export async function answerUiCall(a: UiAnswer): Promise<UiAnswerOutcome> {
  if (!UUID_RE.test(a.callId) || !UUID_RE.test(a.loginId)) return 'not_found';
  const [hit] = await systemDb
    .update(uiCalls)
    .set({ status: 'done', result: a.result, answeredAt: sql`now()` })
    .where(
      and(
        eq(uiCalls.id, a.callId),
        eq(uiCalls.turnId, a.turnId),
        eq(uiCalls.loginId, a.loginId),
        eq(uiCalls.windowId, a.windowId),
        eq(uiCalls.status, 'pending'),
        gt(uiCalls.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: uiCalls.id });
  if (hit) {
    await notifyUiResult(hit.id);
    return 'done';
  }
  return uiAnswerMiss(await readUiCall(a.callId), a);
}

/** Give up a turn's open calls (the person pressed Stop): each wakes its
 *  wait, which answers `stopped`. Returns how many. */
export async function expireTurnUiCalls(p: { turnId: string; loginId: string }): Promise<number> {
  if (!UUID_RE.test(p.loginId)) return 0;
  const rows = await systemDb
    .update(uiCalls)
    .set({ status: 'expired' })
    .where(
      and(
        eq(uiCalls.turnId, p.turnId),
        eq(uiCalls.loginId, p.loginId),
        eq(uiCalls.status, 'pending'),
      ),
    )
    .returning({ id: uiCalls.id });
  for (const r of rows) await notifyUiResult(r.id);
  return rows.length;
}

/** Wake the wait of call `id`. Never throws, and says nothing: the wait
 *  polls the row anyway, so a lost NOTIFY only costs it up to one poll. */
async function notifyUiResult(id: string): Promise<void> {
  await systemDb.execute(sql`SELECT pg_notify(${UI_RESULT_CHANNEL}, ${id})`).catch(() => {});
}
