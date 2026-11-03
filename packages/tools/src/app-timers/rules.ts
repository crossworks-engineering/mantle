/**
 * App timers (docs/app-timers.md): the limits, the fixed error texts, and
 * the one rule for which tools a timer may call.
 *
 * A timer calls one tool of its app on a clock, with no model and no
 * person per run, so it may only call a tool that changes nothing, spends
 * nothing and reaches no shell or sandbox: a builtin whose policy is a read
 * that spends nothing and starts no model work, or an HTTP tool an admin
 * marked as only reading (External access, apiToolPolicy). A connector's
 * tool, a recipe and a shell tool are refused: their effect is not one this
 * brain can vouch for. A tool marked risky (peerRisky: every peer_* tool)
 * needs an Admin user to have set the timer, and so does an HTTP tool whose
 * templates name a vault secret (a box's key called on a clock). The tool
 * must be declared by the app (app_tools_set) and must not need the
 * owner's confirmation. Asked when a timer is set and again before every
 * run: a policy, a declaration or a confirmation flag can change in
 * between.
 *
 * How often (timerMinMinutes): an Admin user's timer every minute at most,
 * anyone else's every 5, and any HTTP tool's every 15 (an outside API on a
 * clock goes around the per-route limits a person's calls meet). Held when
 * set, and again at every run (a login that is no Admin user now runs at
 * its floor whatever the timer says).
 */
import type { Tool, ToolHandler } from '@mantle/db';
import { builtinPolicy, type ToolPolicy } from '../tool-policy';
import { apiToolPolicy } from '../runtime-policy';
import { handlerCarriesSecretRefs } from '../secret-ref-gate';
import { validateToolArgs } from '../validate-args';

/** The run log in an app's own database: the reserved table the content
 *  SQL runner guards (app-sql-runner.ts APP_TIMER_RUNS_TABLE, pinned equal
 *  by rules.test.ts). Kept here so a tool's description does not load the
 *  app SQL broker. */
export const APP_TIMER_RUNS_TABLE = '_timer_runs';
/** The most timers one app holds (the database's cap too). */
export const APP_TIMERS_PER_APP = 5;
/** The most timers one box holds (the database's cap too). */
export const APP_TIMERS_PER_BOX = 100;
/** every_minutes: at least (an Admin user's), at most, and the default. */
export const APP_TIMER_MIN_MINUTES = 1;
/** every_minutes at least for a timer a login that is no Admin user set. */
export const APP_TIMER_MEMBER_MIN_MINUTES = 5;
/** every_minutes at least for a timer that calls an HTTP tool. */
export const APP_TIMER_HTTP_MIN_MINUTES = 15;
/** The most timers one login sets (the database's cap too). */
export const APP_TIMERS_PER_LOGIN = 20;
/** Of the box's timers, the most set by logins that are no Admin user (the
 *  rest are kept for Admin users; the database's cap too). */
export const APP_TIMERS_NON_ADMIN = 80;
export const APP_TIMER_MAX_MINUTES = 1440;
export const APP_TIMER_DEFAULT_MINUTES = 5;
/** keep_days: at most, and the default. */
export const APP_TIMER_MAX_KEEP_DAYS = 400;
export const APP_TIMER_DEFAULT_KEEP_DAYS = 90;
/** The largest arguments object, as JSON text (the database's check too). */
export const APP_TIMER_ARGS_MAX_BYTES = 8 * 1024;
/** The largest result a run keeps, as JSON text: past it the run is
 *  recorded failed ('result too large'). */
export const APP_TIMER_RESULT_MAX_BYTES = 256 * 1024;
/** How long one run may take before it is recorded failed ('timed out'). */
export const APP_TIMER_DEADLINE_MS = 60_000;
/** Failures in a row before a timer backs off, and how far apart it then
 *  runs at most. A success brings it back to its own interval. */
export const APP_TIMER_BACKOFF_AFTER = 5;
export const APP_TIMER_BACKOFF_MINUTES = 30;
/** A name: lower case, digits, `_` and `-`, at most 48 (the database's
 *  check too). */
export const APP_TIMER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** The fixed texts a failed run records (last_error, the run log's
 *  `error`, the trace): never a caught error's or a remote's words. */
export const APP_TIMER_ERRORS = Object.freeze({
  loginGone: 'the login that set this timer is gone',
  loginCannot: 'the login that set this timer may no longer run it',
  appGone: 'the app is gone',
  toolNotAllowed: 'the tool is not one a timer may call',
  refused: 'the call was refused',
  failed: 'the tool call failed',
  timedOut: 'the tool call timed out',
  tooLarge: 'result too large',
  dbFull: 'the app database is full',
  dbFailed: 'the run could not be recorded',
  internal: 'the run stopped on an internal error',
});

export type AppTimerError = (typeof APP_TIMER_ERRORS)[keyof typeof APP_TIMER_ERRORS];

/** What the rule needs of the tool row. */
type ToolRow = Pick<
  Tool,
  'slug' | 'handler' | 'requiresConfirm' | 'externalAccess' | 'description' | 'inputSchema'
> &
  Partial<Pick<Tool, 'createdBy'>>;

/** The tool rule's answer: with the timer's floor (timerMinMinutes). */
export type TimerToolVerdict = { ok: true; minMinutes: number } | { ok: false; reason: string };

/** The shortest interval a timer of `handler`, set by a login that is (or
 *  is not) an Admin user, runs at (see the head). */
export function timerMinMinutes(handler: ToolHandler, setterIsAdmin: boolean): number {
  if (handler.kind === 'http') return APP_TIMER_HTTP_MIN_MINUTES;
  return setterIsAdmin ? APP_TIMER_MIN_MINUTES : APP_TIMER_MEMBER_MIN_MINUTES;
}

/** Why `args` do not fit the tool's input schema (its required arguments,
 *  their types, no unknown one on a closed schema), or null. */
export function timerArgsProblem(
  tool: Pick<Tool, 'slug' | 'inputSchema'>,
  args: Record<string, unknown>,
): string | null {
  const v = validateToolArgs(
    (tool.inputSchema as Record<string, unknown> | null) ?? null,
    args,
    tool.slug,
  );
  return v.error;
}

/** Whether a builtin's policy is one a timer may call: a read that spends
 *  nothing, starts no model work and reaches no shell or sandbox. */
function builtinTimerSafe(p: ToolPolicy): boolean {
  if (p.effect !== 'read' || p.spends !== 'none' || p.startsModelWork) return false;
  const via = p.outside?.via;
  return via !== 'shell' && via !== 'sandbox';
}

/**
 * May a timer call `tool` for an app that declares `declared`, set by a
 * login that is (or is not) an Admin user? The one rule, at set time and
 * before every run (see the head).
 */
export function timerToolVerdict(
  tool: ToolRow | null,
  slug: string,
  declared: readonly string[],
  setterIsAdmin: boolean,
): TimerToolVerdict {
  if (!declared.includes(slug)) {
    return {
      ok: false,
      reason: `The app does not declare the tool '${slug}': declare it with app_tools_set first.`,
    };
  }
  if (!tool) return { ok: false, reason: `There is no tool '${slug}' on this brain.` };
  if (tool.requiresConfirm) {
    return {
      ok: false,
      reason: `The tool '${slug}' needs the owner's confirmation for each call, so no timer may call it.`,
    };
  }
  const h = tool.handler;
  if (h.kind === 'builtin') {
    const p = builtinPolicy(h.ref);
    if (!p || !builtinTimerSafe(p)) {
      return {
        ok: false,
        reason: `The tool '${slug}' changes, sends or spends something: a timer calls only tools that read and spend nothing.`,
      };
    }
    if (p.peerRisky && !setterIsAdmin) {
      return {
        ok: false,
        reason: `The tool '${slug}' is a risky tool: only an Admin user may set a timer that calls it.`,
      };
    }
    return { ok: true, minMinutes: timerMinMinutes(h, setterIsAdmin) };
  }
  if (h.kind === 'http') {
    const p = apiToolPolicy(tool);
    if (p.effect !== 'read' || p.spends !== 'none') {
      return {
        ok: false,
        reason: `The HTTP tool '${slug}' is not marked as only reading (External access): a timer calls only tools that read.`,
      };
    }
    if (handlerCarriesSecretRefs(h) && !setterIsAdmin) {
      return {
        ok: false,
        reason: `The HTTP tool '${slug}' sends a vault secret: only an Admin user may set a timer that calls it.`,
      };
    }
    return { ok: true, minMinutes: timerMinMinutes(h, setterIsAdmin) };
  }
  return {
    ok: false,
    reason: `The tool '${slug}' is a ${h.kind} tool: a timer calls only built-in reads and HTTP tools marked as only reading.`,
  };
}

/** A timer's first run after it is set: within a minute (so a new timer
 *  shows a run soon), spread so a batch of timers set together does not
 *  fire in one second. */
export function firstRunAfter(at: Date, random: () => number = Math.random): Date {
  return new Date(at.getTime() + Math.floor(random() * 30_000));
}
