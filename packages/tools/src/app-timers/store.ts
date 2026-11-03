/**
 * The app_timers rows (migration 0355; docs/app-timers.md).
 *
 * Two kinds of caller, and the database tells them apart:
 *  - the app_timer tools, in the caller's own scope: every read is the row
 *    rule's (an app the scope manages) and every write the write role's
 *    (the write check asks manage of the app), so a login that may not
 *    manage the app reads none of its timers and changes none;
 *  - the scheduler (the maintenance worker), system work outside every
 *    scope: the claim of the due timers and each run's outcome.
 *
 * The caps are the database's (mantle_app_timers_cap, 23514 with the
 * constraint app_timers_per_app_cap, app_timers_per_login_cap,
 * app_timers_box_cap or app_timers_admin_reserve_cap), answered here in
 * words.
 *
 * The run in flight: a timer is claimed right before it runs (claim_id,
 * claimed_at), one at a time, and a claim is live for
 * APP_TIMER_CLAIM_MINUTES. A live claim is never cleared by a set, and a
 * timer under one is neither claimed again nor made due now: only the
 * claim's holder writes the outcome and lets it go.
 */
import { and, asc, eq, lte, not, sql, type SQL } from 'drizzle-orm';
import {
  appTimers,
  db,
  isCheckViolation,
  isUniqueViolation,
  pgConstraint,
  type AppTimerRow,
} from '@mantle/db';
import { ConflictError, InputError } from '@mantle/std';
import {
  APP_TIMER_BACKOFF_AFTER,
  APP_TIMER_BACKOFF_MINUTES,
  APP_TIMERS_NON_ADMIN,
  APP_TIMERS_PER_APP,
  APP_TIMERS_PER_BOX,
  APP_TIMERS_PER_LOGIN,
} from './rules';

/** What a tool asks to set (create or update by name). */
export type AppTimerSet = {
  ownerId: string;
  appId: string;
  name: string;
  toolSlug: string;
  args: Record<string, unknown>;
  everyMinutes: number;
  keepDays: number;
  enabled: boolean;
  /** The login it runs as from now on: the caller's. */
  loginId: string;
  /** Its next run, when this set starts it (a new timer, a changed one or
   *  one switched on); unset: as it was. For a timer that has run, never
   *  sooner than its floor after the last run (see setAppTimer). */
  nextRunAt?: Date;
  /** The rule's floor for this timer as set (timerMinMinutes). */
  minMinutes: number;
};

/** How long a claim is live: no tick claims the timer again, no set clears
 *  it, no app_timer_run makes it due, until its holder lets it go or this
 *  passes (a worker that died mid-run). Well over one run: the deadline
 *  (APP_TIMER_DEADLINE_MS, 60 s) and the record (30 s at most). */
export const APP_TIMER_CLAIM_MINUTES = 5;

/** A claim that is live now. */
const liveClaim = () =>
  sql<boolean>`(${appTimers.claimId} is not null and ${appTimers.claimedAt} > now() - make_interval(mins => ${APP_TIMER_CLAIM_MINUTES}::int))`;

/** The timers of one app the caller may manage, by name. In the caller's
 *  scope: the row rule decides. */
export async function listAppTimers(appId: string): Promise<AppTimerRow[]> {
  return db
    .select()
    .from(appTimers)
    .where(eq(appTimers.appNodeId, appId))
    .orderBy(asc(appTimers.name));
}

/** One timer of an app by name, or null. In the caller's scope. */
export async function getAppTimer(appId: string, name: string): Promise<AppTimerRow | null> {
  const [row] = await db
    .select()
    .from(appTimers)
    .where(and(eq(appTimers.appNodeId, appId), eq(appTimers.name, name)))
    .limit(1);
  return row ?? null;
}

/** The database's caps, in words (a ConflictError: the caller sees it). */
function capError(err: unknown): never {
  if (isCheckViolation(err)) {
    const name = pgConstraint(err);
    if (name === 'app_timers_per_app_cap') {
      throw new ConflictError(
        `An app has at most ${APP_TIMERS_PER_APP} timers: delete one (app_timer_delete) first.`,
        { cause: err },
      );
    }
    if (name === 'app_timers_per_login_cap') {
      throw new ConflictError(
        `One login sets at most ${APP_TIMERS_PER_LOGIN} app timers: delete one of yours first.`,
        { cause: err },
      );
    }
    if (name === 'app_timers_box_cap') {
      throw new ConflictError(
        `This box runs at most ${APP_TIMERS_PER_BOX} app timers: delete one first.`,
        { cause: err },
      );
    }
    if (name === 'app_timers_admin_reserve_cap') {
      throw new ConflictError(
        `Logins that are no Admin user set at most ${APP_TIMERS_NON_ADMIN} of this box's ${APP_TIMERS_PER_BOX} app timers (the rest are kept for Admin users): delete one first, or ask an Admin user.`,
        { cause: err },
      );
    }
  }
  if (isUniqueViolation(err)) {
    throw new ConflictError('A timer of that name was set at the same moment: try again.', {
      cause: err,
    });
  }
  throw err;
}

/**
 * Create the app's timer `name`, or change it. In the caller's scope (the
 * write check asks manage of the app). A change re-stamps the login it
 * runs as to the caller's (as a heartbeat's maker); a run in flight keeps
 * its claim and writes its outcome (its next run follows from this
 * setting). Returns the row and whether it was made.
 *
 * A set is no way around the floors (as app_timer_run is not): a timer
 * that has run gets its new next run no sooner than its floor after the
 * last run, the back-off judged on the failures in a row before this set,
 * so flipping a setting back and forth runs it no more often than its
 * clock could. The failures in a row start over only when the call itself
 * changes (the tool or its args): another clock or a switch on is the same
 * call, failing the same way.
 */
export async function setAppTimer(t: AppTimerSet): Promise<{ row: AppTimerRow; created: boolean }> {
  const existing = await getAppTimer(t.appId, t.name);
  const now = new Date();
  try {
    if (existing) {
      const [row] = await db
        .update(appTimers)
        .set({
          toolSlug: t.toolSlug,
          args: t.args,
          everyMinutes: t.everyMinutes,
          keepDays: t.keepDays,
          enabled: t.enabled,
          createdBy: t.loginId,
          updatedAt: now,
          // SET reads the row as it was: the old tool, args and count.
          failCount: sql<number>`(case when ${appTimers.toolSlug} = ${t.toolSlug}
              and ${appTimers.args} = ${JSON.stringify(t.args)}::jsonb
            then ${appTimers.failCount} else 0 end)`,
          ...(t.nextRunAt
            ? {
                nextRunAt: sql<Date>`greatest(${t.nextRunAt.toISOString()}::timestamptz,
                  ${appTimers.lastRunAt} + make_interval(mins => ${floorMinutes(t.minMinutes)}))`,
              }
            : {}),
        })
        .where(eq(appTimers.id, existing.id))
        .returning();
      if (!row) throw new InputError(`The timer '${t.name}' is gone: set it again.`);
      return { row, created: false };
    }
    const [row] = await db
      .insert(appTimers)
      .values({
        ownerId: t.ownerId,
        appNodeId: t.appId,
        name: t.name,
        toolSlug: t.toolSlug,
        args: t.args,
        everyMinutes: t.everyMinutes,
        keepDays: t.keepDays,
        enabled: t.enabled,
        createdBy: t.loginId,
        nextRunAt: t.nextRunAt ?? now,
      })
      .returning();
    if (!row) throw new Error('the timer insert returned no row');
    return { row, created: true };
  } catch (err) {
    return capError(err);
  }
}

/** Remove the app's timer `name`; the id it had, or null when there was
 *  none. In the caller's scope. */
export async function deleteAppTimer(appId: string, name: string): Promise<string | null> {
  const [gone] = await db
    .delete(appTimers)
    .where(and(eq(appTimers.appNodeId, appId), eq(appTimers.name, name)))
    .returning({ id: appTimers.id });
  return gone?.id ?? null;
}

/** The least minutes between two runs of a timer: the rule's floor
 *  (`minMinutes`, timerMinMinutes), raised to the back-off once the timer
 *  has failed APP_TIMER_BACKOFF_AFTER times in a row. */
function floorMinutes(minMinutes: number): SQL<number> {
  const min = Math.max(1, Math.floor(minMinutes));
  return sql<number>`(case when ${appTimers.failCount} >= ${APP_TIMER_BACKOFF_AFTER}::int
      then greatest(${min}::int, ${APP_TIMER_BACKOFF_MINUTES}::int) else ${min}::int end)`;
}

/** What app_timer_run gets back: the row made due, 'running' while a run of
 *  it holds a live claim, `{ notBefore }` while its last run is closer than
 *  its floor (back-off included), null when there is none. */
export type AppTimerQueued = AppTimerRow | 'running' | { notBefore: Date } | null;

/** Make the app's timer `name` due now (app_timer_run): the next tick runs
 *  it. In the caller's scope. Never under a live claim, and never sooner
 *  than its floor after its last run (`minMinutes`, the rule's floor for
 *  this timer, with the back-off on top): a run on demand is a run like any
 *  other, so the floors and the capacity they set hold for it too. */
export async function queueAppTimerNow(
  appId: string,
  name: string,
  minMinutes: number,
): Promise<AppTimerQueued> {
  const floor = floorMinutes(minMinutes);
  const notBefore = sql<Date>`${appTimers.lastRunAt} + make_interval(mins => ${floor})`;
  const [row] = await db
    .update(appTimers)
    .set({ nextRunAt: sql`now()` as SQL<Date>, updatedAt: new Date() })
    .where(
      and(
        eq(appTimers.appNodeId, appId),
        eq(appTimers.name, name),
        not(liveClaim()),
        sql`(${appTimers.lastRunAt} is null or ${notBefore} <= now())`,
      ),
    )
    .returning();
  if (row) return row;
  const [held] = await db
    .select({ running: liveClaim(), notBefore })
    .from(appTimers)
    .where(and(eq(appTimers.appNodeId, appId), eq(appTimers.name, name)));
  if (!held) return null;
  if (held.running) return 'running';
  return { notBefore: new Date(held.notBefore) };
}

// ── The scheduler's (system work) ────────────────────────────────────────

/**
 * Claim the next due timer, right before it runs: in one transaction, the
 * oldest due row under no live claim, locked FOR UPDATE SKIP LOCKED (a row
 * another tick holds is passed over, never waited for), stamped with a
 * fresh claim. Its next_run_at is left as it is: the live claim is what
 * keeps every other tick off it. Null when nothing is due. System work.
 */
export async function claimNextDueAppTimer(): Promise<AppTimerRow | null> {
  return db.transaction(async (tx) => {
    const [due] = await tx
      .select({ id: appTimers.id })
      .from(appTimers)
      .where(
        and(eq(appTimers.enabled, true), lte(appTimers.nextRunAt, sql`now()`), not(liveClaim())),
      )
      .orderBy(asc(appTimers.nextRunAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!due) return null;
    const [row] = await tx
      .update(appTimers)
      .set({
        claimId: sql`gen_random_uuid()` as SQL<string>,
        claimedAt: sql`now()` as SQL<Date>,
      })
      .where(eq(appTimers.id, due.id))
      .returning();
    return row ?? null;
  });
}

/** One run's outcome, as the timer row keeps it. */
export type AppTimerOutcome = {
  ranAt: Date;
  ok: boolean;
  ms: number;
  /** A fixed text (APP_TIMER_ERRORS) on a failure. */
  error: string | null;
  /** The shortest interval the timer runs at now (timerMinMinutes). */
  minMinutes: number;
};

/**
 * Write a claimed run's outcome and let go of the claim, only while the
 * claim is still this one's. The failures in a row and the next run are
 * the row's own as it is now (a set during the run counts): its interval,
 * at least `minMinutes`, or after APP_TIMER_BACKOFF_AFTER failures in a
 * row at least APP_TIMER_BACKOFF_MINUTES; plus a jitter of up to a tenth
 * of it (30 s at most), so timers set together drift apart. System work.
 */
export async function finishAppTimerRun(
  id: string,
  claimId: string,
  o: AppTimerOutcome,
): Promise<boolean> {
  const fails = o.ok ? sql`0` : sql`${appTimers.failCount} + 1`;
  const min = Math.max(1, Math.floor(o.minMinutes));
  // floorMinutes, judged on the count after this run.
  const minutes = sql`(case when ${fails} >= ${APP_TIMER_BACKOFF_AFTER}::int
      then greatest(${appTimers.everyMinutes}, ${min}::int, ${APP_TIMER_BACKOFF_MINUTES}::int)
      else greatest(${appTimers.everyMinutes}, ${min}::int) end)`;
  const done = await db
    .update(appTimers)
    .set({
      lastRunAt: o.ranAt,
      lastOk: o.ok,
      lastError: o.error,
      lastMs: Math.max(0, Math.round(o.ms)),
      failCount: sql`${fails}` as SQL<number>,
      nextRunAt:
        sql`now() + make_interval(secs => ${minutes} * 60 + floor(random() * least(30, ${minutes} * 6)))` as SQL<Date>,
      claimId: null,
      claimedAt: null,
    })
    .where(and(eq(appTimers.id, id), eq(appTimers.claimId, claimId)))
    .returning({ id: appTimers.id });
  return done.length > 0;
}

/** The ids of an app's timers (the run log keeps their rows only). System
 *  work. */
export async function appTimerIds(appId: string): Promise<string[]> {
  const rows = await db
    .select({ id: appTimers.id })
    .from(appTimers)
    .where(eq(appTimers.appNodeId, appId));
  return rows.map((r) => r.id);
}
