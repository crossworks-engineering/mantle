/**
 * One app timer run (docs/app-timers.md): the timer's tool called as the
 * login that set it, at that login's rules for the app, through the one
 * gate as an app broker's call, with no model and no person.
 *
 * The plan is the app tool broker's own (app-tool-run.ts appToolRunPlan,
 * the one function server/web lib/app-tool-broker.ts runs a person's
 * host.tools.call with): an Admin user at the rules the app's holders and
 * author allow (via 'owner'), anyone else at the team rules (via
 * 'member'); the verdict on the app's declared tools; the surface and the
 * scope: the login's own rights at either rules (adminScope 'login': there
 * is no request to run in), as by hand (owner decision 2026-11-09). The dispatch goes through
 * the one gate as the app's broker (appBrokerCaller), so every right,
 * area, narrower and refusal of host.tools.call applies. Read only twice
 * over: the scope writes nothing, and the actor is the login read only
 * (mode 'ro'), so even a tool that tried to write would be refused. A tool
 * that needs the owner's confirmation never runs: no one is there to
 * confirm. An HTTP tool's own timeout is cut to the run's deadline
 * (httpTimeoutMs); a built-in read that outlives it goes on to its end
 * with its answer dropped.
 *
 * Fails closed, recorded as a failed run with a fixed text
 * (APP_TIMER_ERRORS), never a caught error's: the login gone (NULL), not
 * usable now (disabled: no workspace), no longer managing the app
 * (assertItemRight 'manage' in its own scope), not an Admin user for a
 * tool that needs one, the app gone, the tool no longer one a timer may
 * call (timerToolVerdict, asked again here), the verdict refused, the
 * call failed, timed out, or its result too large.
 *
 * Bookkeeping as the scheduler's system work: the reads of the app, the
 * tool and the login before the run; the app's Activity rows (one per
 * run, as the broker's per call, and an error row for a failure); the run
 * log row in the app's own database (appTimerRecordRun, with the rules the
 * run was judged at; when the app no longer runs at admin rules, every row
 * of it kept at admin rules goes first, whatever the run came to); one
 * trace per run (kind 'manual', subject
 * 'app_timer', a step `app_timer: <tool>`, no model step).
 */
import { eq } from 'drizzle-orm';
import {
  assertItemRight,
  authUsers,
  db,
  loginActor,
  loginHoldsAdmin,
  loginScopeFor,
  runAsActor,
  withTurnScope,
  withViewer,
  type AppTimerRow,
} from '@mantle/db';
import { getAppRuntime, recordAppAccess, recordAppError } from '@mantle/content';
import { appTimerRecordRun, isAppDbFull } from '@mantle/content/app-broker';
import { sleep } from '@mantle/std';
import { startTrace, step } from '@mantle/tracing';
import { appHeldBelowAdmin, appToolRunPlan } from '../app-tool-run';
import { dispatchTool } from '../dispatch';
import { outsideCallLogDetail } from '../external-access';
import { appBrokerCaller } from '../gate-callers';
import { resolveTool } from '../resolve';
import type { ToolHandlerResult } from '../types';
import {
  APP_TIMER_DEADLINE_MS,
  APP_TIMER_ERRORS,
  APP_TIMER_MEMBER_MIN_MINUTES,
  APP_TIMER_RESULT_MAX_BYTES,
  timerToolVerdict,
} from './rules';

/** What one run came to. */
export type AppTimerRunResult = {
  ok: boolean;
  ms: number;
  /** A fixed text (APP_TIMER_ERRORS) on a failure. */
  error: string | null;
  /** The shortest interval the timer runs at now (rules.ts
   *  timerMinMinutes); the member floor when the rule was not reached. */
  minMinutes: number;
};

/** What a run may be told to do differently (tests). */
export type AppTimerRunOpts = {
  deadlineMs?: number;
  resultMaxBytes?: number;
  now?: () => Date;
};

/** The login's name on the team surface (as the member broker names it). */
async function runnerName(loginId: string): Promise<string> {
  const [row] = await db
    .select({ name: authUsers.displayName, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return row?.name?.trim() || row?.email?.split('@')[0] || 'app timer';
}

/** What the call came to, before the record. */
type Called = {
  minMinutes: number;
  level: 'admin' | 'team' | null;
  /** The app runs below admin rules now (appHeldBelowAdmin): its rows
   *  kept at admin rules go, whatever the call came to. */
  purgeAdmin: boolean;
} & ({ ok: true; result: string } | { ok: false; error: string; logged?: true });

/** The call, or a fixed failure: the steps of the head, before the record. */
async function call(
  timer: AppTimerRow,
  deadlineMs: number,
  resultMaxBytes: number,
): Promise<Called> {
  let minMinutes = APP_TIMER_MEMBER_MIN_MINUTES;
  let level: Called['level'] = null;
  let purgeAdmin = false;
  const fail = (error: string, logged?: true): Called => ({
    ok: false,
    error,
    minMinutes,
    level,
    purgeAdmin,
    ...(logged ? { logged } : {}),
  });
  const app = await getAppRuntime(timer.ownerId, timer.appNodeId);
  if (!app) return fail(APP_TIMER_ERRORS.appGone);
  // Judged first, from the app alone: a run that fails before its rules are
  // judged (the login gone or barred, the tool no longer allowed) still
  // clears what was read at admin rules from an app that no longer runs
  // at them.
  purgeAdmin = appHeldBelowAdmin(app);
  const loginId = timer.createdBy;
  if (!loginId) return fail(APP_TIMER_ERRORS.loginGone);
  const declared = app.manifest.toolSlugs ?? [];
  const slug = timer.toolSlug;
  const admin = await loginHoldsAdmin(loginId);
  // As the login now, read only: its own scope says whether it still
  // manages the app (an enabled login of a workspace that may), before
  // anything is judged or run.
  let actor;
  try {
    actor = loginActor(loginId, 'ro');
    await runAsActor(actor, async () => {
      const own = await loginScopeFor(loginId);
      await withTurnScope(own, () => assertItemRight(app.id, 'manage', { changes: true }));
    });
  } catch {
    return fail(APP_TIMER_ERRORS.loginCannot);
  }
  // The timer rule again: a policy, a declaration or a confirmation flag
  // may have changed since the timer was set.
  const rule = timerToolVerdict(await resolveTool(timer.ownerId, slug), slug, declared, admin);
  if (!rule.ok) return fail(APP_TIMER_ERRORS.toolNotAllowed);
  minMinutes = rule.minMinutes;
  const args = timer.args ?? {};
  // The broker's own plan for this login (see the head).
  const plan = appToolRunPlan(
    {
      via: admin ? 'owner' : 'member',
      ownerId: timer.ownerId,
      runner: { loginId, name: await runnerName(loginId) },
      adminScope: 'login',
    },
    app,
    slug,
    args,
  );
  level = plan.rules === 'admin' || plan.rules === 'team' ? plan.rules : null;
  const verdict = await plan.verdict();
  const who = { ownerId: timer.ownerId, appNodeId: app.id, actorId: loginId };
  const tagged = { via: 'timer', timer: timer.name, slug };
  // No one is there to confirm a call that needs the owner's Yes.
  const refused = !verdict.ok || (plan.confirm && verdict.tool.requiresConfirm);
  if (refused) {
    recordAppAccess({
      ...who,
      kind: 'tool',
      detail: { ...tagged, refused: APP_TIMER_ERRORS.refused },
    });
    recordAppError({
      ...who,
      source: 'tool',
      via: 'timer',
      slug,
      message: APP_TIMER_ERRORS.refused,
      status: verdict.ok ? 409 : verdict.status,
    });
    return fail(APP_TIMER_ERRORS.refused, true);
  }
  recordAppAccess({
    ...who,
    kind: 'tool',
    detail: { ...tagged, ...outsideCallLogDetail(verdict, args) },
  });
  const scope = { actsFor: await plan.actsFor() };
  // The call in the run's scope, read only, as the login now.
  const dispatch = () =>
    dispatchTool(
      verdict.tool,
      { ...args },
      {
        ownerId: timer.ownerId,
        surface: plan.surface,
        caller: appBrokerCaller(plan.surface, verdict),
        httpTimeoutMs: deadlineMs,
      },
    );
  const ran = runAsActor(actor, () =>
    scope.actsFor ? withViewer(scope.actsFor, dispatch) : dispatch(),
  );
  let outcome: ToolHandlerResult | 'timed out';
  try {
    outcome = await Promise.race([ran, sleep(deadlineMs).then(() => 'timed out' as const)]);
  } catch {
    outcome = { ok: false, error: APP_TIMER_ERRORS.failed };
  }
  if (outcome === 'timed out') {
    // The call goes on to its end; its answer is not kept.
    ran.catch(() => {});
    return fail(APP_TIMER_ERRORS.timedOut);
  }
  if (!outcome.ok) {
    recordAppError({
      ...who,
      source: 'tool',
      via: 'timer',
      slug,
      message: APP_TIMER_ERRORS.failed,
      status: 200,
    });
    return fail(APP_TIMER_ERRORS.failed, true);
  }
  let text: string;
  try {
    text = JSON.stringify(outcome.output ?? null) ?? 'null';
  } catch {
    return fail(APP_TIMER_ERRORS.failed);
  }
  if (Buffer.byteLength(text) > resultMaxBytes) return fail(APP_TIMER_ERRORS.tooLarge);
  return { ok: true, result: text, minMinutes, level, purgeAdmin };
}

/**
 * Run one claimed timer and record it in its app's run log. System work
 * (the scheduler); never throws: anything unexpected is a failed run with
 * the fixed internal text.
 */
export async function runAppTimer(
  timer: AppTimerRow,
  liveTimerIds: readonly string[],
  opts: AppTimerRunOpts = {},
): Promise<AppTimerRunResult> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const deadlineMs = opts.deadlineMs ?? APP_TIMER_DEADLINE_MS;
  return startTrace(
    {
      ownerId: timer.ownerId,
      kind: 'manual',
      subjectKind: 'app_timer',
      subjectId: timer.id,
      loginId: timer.createdBy,
      data: { source: 'app_timer', app_id: timer.appNodeId, timer: timer.name },
    },
    () =>
      step(
        {
          name: `app_timer: ${timer.toolSlug}`,
          kind: 'compute',
          input: { app_id: timer.appNodeId, timer: timer.name, slug: timer.toolSlug },
        },
        async (handle): Promise<AppTimerRunResult> => {
          let res: Called;
          try {
            res = await call(timer, deadlineMs, opts.resultMaxBytes ?? APP_TIMER_RESULT_MAX_BYTES);
          } catch {
            res = {
              ok: false,
              error: APP_TIMER_ERRORS.internal,
              minMinutes: APP_TIMER_MEMBER_MIN_MINUTES,
              level: null,
              purgeAdmin: false,
            };
          }
          const ms = now().getTime() - started.getTime();
          let error = res.ok ? null : res.error;
          const row = {
            started,
            ms,
            result: res.ok ? res.result : null,
            error,
            level: res.level,
            purgeAdmin: res.purgeAdmin,
          };
          if (error === APP_TIMER_ERRORS.loginGone) {
            // No row for a timer no login holds; the purge all the same.
            if (res.purgeAdmin) await record(timer, liveTimerIds, { ...row, pruneOnly: true });
          } else if (error !== APP_TIMER_ERRORS.appGone) {
            error = await record(timer, liveTimerIds, row);
          }
          if (error) {
            handle.setError(error);
            if (res.ok || !res.logged) {
              recordAppError({
                ownerId: timer.ownerId,
                appNodeId: timer.appNodeId,
                actorId: timer.createdBy,
                source: 'tool',
                via: 'timer',
                slug: timer.toolSlug,
                message: error,
              });
            }
          } else {
            handle.setOutput({ ok: true, ms });
          }
          return { ok: error === null, ms, error, minMinutes: res.minMinutes };
        },
      ),
  ).catch(() => ({
    ok: false,
    ms: now().getTime() - started.getTime(),
    error: APP_TIMER_ERRORS.internal,
    minMinutes: APP_TIMER_MEMBER_MIN_MINUTES,
  }));
}

/** The run log row; the error the run ends with (the call's, or the
 *  record's own: a full file, a failed write). */
async function record(
  timer: AppTimerRow,
  liveTimerIds: readonly string[],
  r: {
    started: Date;
    ms: number;
    result: string | null;
    error: string | null;
    level: 'admin' | 'team' | null;
    purgeAdmin: boolean;
    /** Prune (and purge) only, no row. */
    pruneOnly?: boolean;
  },
): Promise<string | null> {
  const app = await getAppRuntime(timer.ownerId, timer.appNodeId).catch(() => null);
  if (!app) return r.error ?? APP_TIMER_ERRORS.appGone;
  const row = {
    timerId: timer.id,
    ranAt: r.started.toISOString(),
    ok: r.error === null,
    ms: r.ms,
    result: r.error === null ? r.result : null,
    error: r.error,
    level: r.level,
  };
  const opts = {
    keepDays: timer.keepDays,
    liveTimerIds,
    purgeAdmin: r.purgeAdmin,
    ...(r.pruneOnly ? { pruneOnly: true } : {}),
    ...(app.manifest.sqlite ? { schema: app.manifest.sqlite } : {}),
  };
  try {
    await appTimerRecordRun(timer.ownerId, app.id, row, opts);
    return r.error;
  } catch (err) {
    if (!isAppDbFull(err)) return APP_TIMER_ERRORS.dbFailed;
    // Full: free what the prune may, keep no row, and say so.
    await appTimerRecordRun(timer.ownerId, app.id, row, { ...opts, pruneOnly: true }).catch(
      () => {},
    );
    return APP_TIMER_ERRORS.dbFull;
  }
}
