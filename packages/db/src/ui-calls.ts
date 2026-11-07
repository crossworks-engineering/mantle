/**
 * The agent UI channel's calls (migration 0363, docs/agent-ui.md). A ui_*
 * tool opens a call (openUiCall) and waits for its row; the window answers it
 * once (answerUiCall, the result route); a Stop gives up the turn's open
 * calls (expireTurnUiCalls). Every write is through systemDb (the access
 * matrix: INSERT, and UPDATE of status, result and answered_at): a login's
 * scoped role never writes the table, it reads its own rows only.
 *
 * A call's row holds the window's answer only while its turn runs (a DBOS
 * re-run of a ui step reads it back): when the turn ends, on every path,
 * clearTurnUiCalls drops the results and gives up what is still pending, so
 * the row keeps only that the call was made (its step key: a later re-run
 * never asks the window again). It never holds the arguments (they reach the
 * window on the turn's stream event only). The nightly `ui-calls-reap` sweep
 * deletes rows older than UI_CALLS_RETENTION_HOURS (server/web
 * lib/maintenance/ui-calls-reap.ts).
 *
 * The rights live in the WHERE of the answer: the row must be this turn's,
 * this login's and this window's, pending and not expired, so a guessed
 * call id of another login, another turn or another window changes nothing,
 * and an expired call is never answered (whatever the sweep).
 */
import { and, eq, gt, isNotNull, or, sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { systemDb } from './gateway/handles';
import { uiCalls, type UiCallRow } from './schema/ui-calls';

/** The NOTIFY channel an answer (or a Stop) is announced on, its payload the
 *  call id: the process whose tool waits LISTENs and wakes its wait. A plain
 *  string literal, safe for pg_notify. */
export const UI_RESULT_CHANNEL = 'ui_result';

/** Rows older than this go (the nightly `ui-calls-reap` sweep). A turn's
 *  results are cleared when it ends; this takes what a turn that never
 *  ended (a runner gone for good) left. */
export const UI_CALLS_RETENTION_HOURS = 24;

/** One call, as the tool opens it. */
export type OpenUiCall = Readonly<{
  turnId: string;
  loginId: string;
  windowId: string;
  /** The turn id and the tool call's id: the same step re-run finds its row. */
  stepKey: string;
  action: string;
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
      // Never the arguments: typed text or a caption can carry what the
      // window showed. They reach the window on the stream event only.
      args: {},
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
  const ids = await settleTurnUiCalls(p, false);
  for (const id of ids) await notifyUiResult(id);
  return ids.length;
}

/** A turn ended (done, error, Stop, supersede, a used ui budget: every path,
 *  either engine): drop its calls' results, the window's view, and give up
 *  what is still pending. The rows stay, with their status and step key, so
 *  a re-run of a ui step after this never asks the window again. The login's
 *  own rows only. Returns how many rows changed. */
export async function clearTurnUiCalls(p: { turnId: string; loginId: string }): Promise<number> {
  return (await settleTurnUiCalls(p, true)).length;
}

/** The one write of a turn's calls: its pending ones expired, and with
 *  `ended` its results dropped too. The ids it changed. */
async function settleTurnUiCalls(
  p: { turnId: string; loginId: string },
  ended: boolean,
): Promise<string[]> {
  if (!UUID_RE.test(p.loginId)) return [];
  const rows = await systemDb
    .update(uiCalls)
    .set({
      status: sql`case when ${uiCalls.status} = 'pending' then 'expired' else ${uiCalls.status} end`,
      ...(ended ? { result: null } : {}),
    })
    .where(
      and(
        eq(uiCalls.turnId, p.turnId),
        eq(uiCalls.loginId, p.loginId),
        ended
          ? or(isNotNull(uiCalls.result), eq(uiCalls.status, 'pending'))
          : eq(uiCalls.status, 'pending'),
      ),
    )
    .returning({ id: uiCalls.id });
  return rows.map((r) => r.id);
}

/** Wake the wait of call `id`. Never throws, and says nothing: the wait
 *  polls the row anyway, so a lost NOTIFY only costs it up to one poll. */
async function notifyUiResult(id: string): Promise<void> {
  await systemDb.execute(sql`SELECT pg_notify(${UI_RESULT_CHANNEL}, ${id})`).catch(() => {});
}
