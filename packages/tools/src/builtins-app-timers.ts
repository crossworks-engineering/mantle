/**
 * App timers (docs/app-timers.md): app_timer_set, app_timer_list,
 * app_timer_delete and app_timer_run. A timer calls one of a mini app's
 * declared tools on a clock (every 1 to 1440 minutes), with no model and no
 * person per run, as the login that set it; each run appends a row to the
 * app's own database (`_timer_runs`, which the app reads with host.db).
 *
 * Who may set one: a login that manages the app (a Moderator of its home,
 * docs/actors.md "Who may do what": the right app code takes), on its own
 * surfaces (ownerOnly + loginTurns, as app_tools_set). The database decides
 * it twice: assertItemRight 'manage' before any change, and the write check
 * on app_timers (manage of the app). A risky tool (peerRisky) needs an
 * Admin user. Which tools: the timer rule (app-timers/rules.ts
 * timerToolVerdict), asked here and again before every run.
 *
 * app_timer_run makes a timer due now: the scheduler's next tick (within a
 * minute) runs it exactly as it runs on its clock, as the login that set
 * it. Nothing runs in the caller's request.
 */
import type { AppTimerRow } from '@mantle/db';
import { assertItemRight, currentWorkspaceScope, loginHoldsAdmin } from '@mantle/db';
import { getAppRuntime } from '@mantle/content';
import { appTimerPurgeAdminRows } from '@mantle/content/app-broker';
import { UUID_RE } from '@mantle/std';
import {
  APP_TIMER_ARGS_MAX_BYTES,
  APP_TIMER_BACKOFF_AFTER,
  APP_TIMER_DEFAULT_KEEP_DAYS,
  APP_TIMER_DEFAULT_MINUTES,
  APP_TIMER_MAX_KEEP_DAYS,
  APP_TIMER_MAX_MINUTES,
  APP_TIMER_MIN_MINUTES,
  APP_TIMER_HTTP_MIN_MINUTES,
  APP_TIMER_MEMBER_MIN_MINUTES,
  APP_TIMER_NAME_RE,
  APP_TIMER_RUNS_TABLE,
  APP_TIMERS_PER_APP,
  APP_TIMERS_PER_LOGIN,
  firstRunAfter,
  timerArgsProblem,
  timerToolVerdict,
} from './app-timers/rules';
import {
  deleteAppTimer,
  getAppTimer,
  listAppTimers,
  queueAppTimerNow,
  setAppTimer,
} from './app-timers/store';
import { resolveTool } from './resolve';
import { str } from './coerce';
import { actingLoginId, isOwnerSurface, loginTurnSurfaceId, OWNER_ONLY_ERROR } from './surface';
import type { BuiltinToolDef, ToolHandlerResult, ToolPrecondition } from './types';

type Ctx = Parameters<BuiltinToolDef['handler']>[1];

/** The surface rule of the app write tools (builtins-apps.ts
 *  ownerOnlyRefusal): a login's own surfaces and its workspace turns. The
 *  gate refuses the rest first; this is the handler's own check, for the
 *  MCP path that calls handlers directly. */
function surfaceRefusal(ctx: Ctx): { ok: false; error: string } | null {
  if (isOwnerSurface(ctx.surface)) return null;
  const turnLogin = loginTurnSurfaceId(ctx.surface);
  const scope = currentWorkspaceScope();
  if (turnLogin && scope?.kind === 'assistant' && scope.loginId === turnLogin) return null;
  return { ok: false, error: OWNER_ONLY_ERROR };
}

/**
 * A timer switched off or deleted: its rows kept at admin rules leave the
 * app's run log now, since no run of it will prune them again. The count
 * removed, or null when the app's database could not be reached (busy,
 * restoring): the answer then says so.
 */
async function purgeAdminRows(ownerId: string, appId: string, timerId: string) {
  try {
    return await appTimerPurgeAdminRows(ownerId, appId, timerId);
  } catch {
    return null;
  }
}

const PURGE_LATER =
  "Its runs kept at admin rules could not be removed from the app's database just now (it is busy): ";

const APP_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'app_id', nodeType: 'app', lookup: 'app_list' },
];

const APP_ID_PROP = { type: 'string', description: "The app's id (UUID), from `app_list`." };
const NAME_PROP = {
  type: 'string',
  description: "The timer's name in the app: lower case letters, digits, `_` and `-`, at most 48.",
};

const NO_LOGIN =
  'A timer runs as the login that sets it: set it from a signed-in login (your own MCP connection, or your chat).';

/** The app the caller reads, or the one answer a random id gets. */
async function readApp(ctx: Ctx, appId: string) {
  if (!UUID_RE.test(appId)) return null;
  return getAppRuntime(ctx.ownerId, appId);
}

const notFound = (appId: string): ToolHandlerResult => ({
  ok: false,
  error: `app ${appId} not found`,
});

/** What a tool answers of one timer. */
function summary(t: AppTimerRow) {
  return {
    name: t.name,
    tool: t.toolSlug,
    args: t.args,
    every_minutes: t.everyMinutes,
    keep_days: t.keepDays,
    enabled: t.enabled,
    runs_as: t.createdBy,
    next_run_at: t.nextRunAt.toISOString(),
    last_run_at: t.lastRunAt?.toISOString() ?? null,
    last_ok: t.lastOk,
    last_error: t.lastError,
    last_ms: t.lastMs,
    fails_in_a_row: t.failCount,
    backing_off: t.failCount >= APP_TIMER_BACKOFF_AFTER,
  };
}

/** An integer argument in [min, max], its default when absent, or why not. */
function intArg(
  v: unknown,
  name: string,
  min: number,
  max: number,
  dflt: number,
): number | { error: string } {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return { error: `${name} is a whole number from ${min} to ${max}.` };
  }
  return v;
}

const app_timer_set: BuiltinToolDef = {
  slug: 'app_timer_set',
  policy: {
    idempotent: true, // a set by name replaces what it says
    matrix: { action: 'editDraft', param: 'app_id', kinds: ['app'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'app_id' }],
    peerRisky: true,
    keyArea: 'apps',
    clientSourced: { kind: 'write', apps: ['app_id'] },
  },
  ownerOnly: true,
  loginTurns: true,
  preconditions: APP_PRE,
  name: "Set a mini app's timer",
  description: `Create or change (by name) a timer that calls ONE of the app's declared tools on a clock, as you, with no model and no person. Each run adds a row to the app's own \`${APP_TIMER_RUNS_TABLE}\` table (timer_id, ran_at, ok, ms, result JSON, error, level), which the app reads with host.db.query; rows past keep_days go. Only a declared tool that reads and spends nothing, with args its schema takes; a risky tool (peer_status) or an HTTP tool with a vault secret needs an Admin user. Floors: 1 minute for an Admin user, ${APP_TIMER_MEMBER_MIN_MINUTES} for anyone else, ${APP_TIMER_HTTP_MIN_MINUTES} for an HTTP tool. You must manage the app. At most ${APP_TIMERS_PER_APP} per app, ${APP_TIMERS_PER_LOGIN} per login. First run within a minute.`,
  inputSchema: {
    type: 'object',
    properties: {
      app_id: APP_ID_PROP,
      name: NAME_PROP,
      tool: { type: 'string', description: "The tool's slug: one the app declares." },
      args: {
        type: 'object',
        description: 'The arguments of every call (one JSON object, at most 8 KB). Default {}.',
      },
      every_minutes: {
        type: 'integer',
        description: `How often it runs, in minutes: ${APP_TIMER_MIN_MINUTES} to ${APP_TIMER_MAX_MINUTES}. Default ${APP_TIMER_DEFAULT_MINUTES}.`,
      },
      keep_days: {
        type: 'integer',
        description: `How many days its runs stay in ${APP_TIMER_RUNS_TABLE}: 1 to ${APP_TIMER_MAX_KEEP_DAYS}. Default ${APP_TIMER_DEFAULT_KEEP_DAYS}.`,
      },
      enabled: { type: 'boolean', description: 'Whether it runs. Default true.' },
    },
    required: ['app_id', 'name', 'tool'],
  },
  handler: async (input, ctx) => {
    const refused = surfaceRefusal(ctx);
    if (refused) return refused;
    const loginId = actingLoginId(ctx.surface);
    if (!loginId) return { ok: false, error: NO_LOGIN };
    const appId = str(input.app_id).trim();
    const name = str(input.name).trim();
    const slug = str(input.tool).trim();
    if (!APP_TIMER_NAME_RE.test(name)) {
      return {
        ok: false,
        error:
          'name must be lower case letters, digits, `_` and `-`, starting with a letter or digit, at most 48.',
      };
    }
    if (!slug) return { ok: false, error: 'tool is required: a slug the app declares.' };
    const args = input.args ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { ok: false, error: 'args is one JSON object.' };
    }
    if (Buffer.byteLength(JSON.stringify(args)) > APP_TIMER_ARGS_MAX_BYTES) {
      return { ok: false, error: `args is at most ${APP_TIMER_ARGS_MAX_BYTES / 1024} KB as JSON.` };
    }
    const every = intArg(
      input.every_minutes,
      'every_minutes',
      APP_TIMER_MIN_MINUTES,
      APP_TIMER_MAX_MINUTES,
      APP_TIMER_DEFAULT_MINUTES,
    );
    if (typeof every !== 'number') return { ok: false, error: every.error };
    const keep = intArg(
      input.keep_days,
      'keep_days',
      1,
      APP_TIMER_MAX_KEEP_DAYS,
      APP_TIMER_DEFAULT_KEEP_DAYS,
    );
    if (typeof keep !== 'number') return { ok: false, error: keep.error };
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      return { ok: false, error: 'enabled is true or false.' };
    }
    const enabled = input.enabled !== false;
    const app = await readApp(ctx, appId);
    if (!app) return notFound(appId);
    // The app's manage first: a clear answer before any change (the write
    // check on app_timers asks the same).
    await assertItemRight(app.id, 'manage', { changes: true });
    const admin = await loginHoldsAdmin(loginId);
    const tool = await resolveTool(ctx.ownerId, slug);
    const rule = timerToolVerdict(tool, slug, app.manifest.toolSlugs ?? [], admin);
    if (!rule.ok) return { ok: false, error: rule.reason };
    if (every < rule.minMinutes) {
      return {
        ok: false,
        error: `every_minutes must be at least ${rule.minMinutes} for this timer (an Admin user's timer every minute, anyone else's every ${APP_TIMER_MEMBER_MIN_MINUTES}, an HTTP tool's every ${APP_TIMER_HTTP_MIN_MINUTES}).`,
      };
    }
    // The arguments as the tool takes them: its required ones, their
    // types, no unknown one on a closed schema.
    const argsProblem = tool ? timerArgsProblem(tool, args as Record<string, unknown>) : null;
    if (argsProblem) return { ok: false, error: `args: ${argsProblem}` };
    const before = await getAppTimer(app.id, name);
    // A new timer, or one whose call or clock changed, or switched on, runs
    // within the minute, but never sooner than its floor (and back-off)
    // after its last run (setAppTimer); an unchanged one keeps its clock.
    const changed =
      !before ||
      before.toolSlug !== slug ||
      JSON.stringify(before.args) !== JSON.stringify(args) ||
      before.everyMinutes !== every ||
      (enabled && !before.enabled);
    const { row, created } = await setAppTimer({
      ownerId: ctx.ownerId,
      appId: app.id,
      name,
      toolSlug: slug,
      args: args as Record<string, unknown>,
      everyMinutes: every,
      keepDays: keep,
      enabled,
      loginId,
      minMinutes: rule.minMinutes,
      ...(changed ? { nextRunAt: firstRunAfter(new Date()) } : {}),
    });
    // Switched off: no run of it prunes its rows any more, so those read at
    // admin rules go now.
    const purged = row.enabled ? 0 : await purgeAdminRows(ctx.ownerId, app.id, row.id);
    ctx.step?.setOutput({ app_id: app.id, name, tool: slug, created });
    return {
      ok: true,
      output: {
        app_id: app.id,
        created,
        timer: summary(row),
        ...(purged === null ? { note: `${PURGE_LATER}set it off again to try once more.` } : {}),
        hint: `Runs as you, every ${every} minute${every === 1 ? '' : 's'}${enabled ? '' : ' once switched on'}. Read its runs in the app with host.db.query('SELECT * FROM ${APP_TIMER_RUNS_TABLE} WHERE timer_id = ? ORDER BY id DESC LIMIT 100', [timerId]); app_timer_list shows each timer's last run.`,
        timer_id: row.id,
      },
    };
  },
};

const app_timer_list: BuiltinToolDef = {
  slug: 'app_timer_list',
  policy: {
    matrix: { action: 'read', param: 'app_id', kinds: ['app'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'apps',
  },
  preconditions: APP_PRE,
  name: "List a mini app's timers",
  description: `The app's timers with their status: tool, args, every_minutes, keep_days, enabled, the login each runs as, the next run, the last run (ok, error, ms) and failures in a row (after 5 a timer runs at most every 30 minutes until one succeeds). Lists the timers of an app you manage. Each run's result is in the app's \`${APP_TIMER_RUNS_TABLE}\` table (app_db_query).`,
  inputSchema: {
    type: 'object',
    properties: { app_id: APP_ID_PROP },
    required: ['app_id'],
  },
  handler: async (input, ctx) => {
    const appId = str(input.app_id).trim();
    const app = await readApp(ctx, appId);
    if (!app) return notFound(appId);
    const rows = await listAppTimers(app.id);
    return {
      ok: true,
      output: {
        app_id: app.id,
        timers: rows.map((t) => ({ timer_id: t.id, ...summary(t) })),
        runs_table: APP_TIMER_RUNS_TABLE,
      },
    };
  },
};

const app_timer_delete: BuiltinToolDef = {
  slug: 'app_timer_delete',
  policy: {
    idempotent: true,
    // It removes a timer row, not the item (its matrix action is the app's
    // editDraft): a delete by its class.
    riskClass: 'delete',
    matrix: { action: 'editDraft', param: 'app_id', kinds: ['app'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'app_id' }],
    peerRisky: true,
    keyArea: 'apps',
    clientSourced: { kind: 'write', apps: ['app_id'] },
  },
  ownerOnly: true,
  loginTurns: true,
  preconditions: APP_PRE,
  name: "Delete a mini app's timer",
  description: `Remove one of the app's timers by name: it stops running. Its rows in \`${APP_TIMER_RUNS_TABLE}\` read at admin rules go at once, the rest with the app's next timer run (or stay while the app has no timer). You need to manage the app.`,
  inputSchema: {
    type: 'object',
    properties: { app_id: APP_ID_PROP, name: NAME_PROP },
    required: ['app_id', 'name'],
  },
  handler: async (input, ctx) => {
    const refused = surfaceRefusal(ctx);
    if (refused) return refused;
    const appId = str(input.app_id).trim();
    const name = str(input.name).trim();
    const app = await readApp(ctx, appId);
    if (!app) return notFound(appId);
    await assertItemRight(app.id, 'manage', { changes: true });
    const gone = await deleteAppTimer(app.id, name);
    if (!gone) {
      return { ok: false, error: `Timer '${name}' not found on this app (app_timer_list).` };
    }
    // Its rows read at admin rules go now; the rest with the app's next
    // timer run.
    const purged = await purgeAdminRows(ctx.ownerId, app.id, gone);
    ctx.step?.setOutput({ app_id: app.id, name, deleted: true });
    return {
      ok: true,
      output: {
        app_id: app.id,
        name,
        deleted: true,
        ...(purged === null
          ? { note: `${PURGE_LATER}they go with the app's next timer run.` }
          : {}),
      },
    };
  },
};

const app_timer_run: BuiltinToolDef = {
  slug: 'app_timer_run',
  policy: {
    matrix: { action: 'editDraft', param: 'app_id', kinds: ['app'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'app_id' }],
    peerRisky: true,
    keyArea: 'apps',
    clientSourced: { kind: 'write', apps: ['app_id'] },
  },
  ownerOnly: true,
  loginTurns: true,
  preconditions: APP_PRE,
  name: "Run a mini app's timer now",
  description: `Run one of the app's timers now, for a test: the scheduler runs it within a minute exactly as on its clock (as the login that set it, the same checks), and its next runs follow from then. See the outcome with app_timer_list, the result in \`${APP_TIMER_RUNS_TABLE}\`. You need to manage the app; the timer must be switched on.`,
  inputSchema: {
    type: 'object',
    properties: { app_id: APP_ID_PROP, name: NAME_PROP },
    required: ['app_id', 'name'],
  },
  handler: async (input, ctx) => {
    const refused = surfaceRefusal(ctx);
    if (refused) return refused;
    const appId = str(input.app_id).trim();
    const name = str(input.name).trim();
    const app = await readApp(ctx, appId);
    if (!app) return notFound(appId);
    await assertItemRight(app.id, 'manage', { changes: true });
    const timer = await getAppTimer(app.id, name);
    if (!timer)
      return { ok: false, error: `Timer '${name}' not found on this app (app_timer_list).` };
    if (!timer.enabled) {
      return {
        ok: false,
        error: `The timer '${name}' is switched off: app_timer_set it with enabled true first.`,
      };
    }
    // The same checks as the run makes, now, so a test hears why at once.
    if (!timer.createdBy) {
      return {
        ok: false,
        error: `The login that set '${name}' is gone: set it again (app_timer_set) to run it as you.`,
      };
    }
    const rule = timerToolVerdict(
      await resolveTool(ctx.ownerId, timer.toolSlug),
      timer.toolSlug,
      app.manifest.toolSlugs ?? [],
      await loginHoldsAdmin(timer.createdBy),
    );
    if (!rule.ok) return { ok: false, error: rule.reason };
    const queued = await queueAppTimerNow(app.id, name, rule.minMinutes);
    if (!queued)
      return { ok: false, error: `Timer '${name}' not found on this app (app_timer_list).` };
    if (queued === 'running') {
      return {
        ok: false,
        error: `Timer '${name}' is running now: see its outcome with app_timer_list in a minute.`,
      };
    }
    if ('notBefore' in queued) {
      // A run on demand keeps the floor (and the back-off) of a run on the
      // clock: the capacity the floors set holds for both.
      return {
        ok: false,
        error: `Timer '${name}' ran too recently to run again now: it can run from ${queued.notBefore.toISOString()} (its least gap between runs, longer after repeated failures).`,
      };
    }
    ctx.step?.setOutput({ app_id: app.id, name, queued: true });
    return {
      ok: true,
      output: {
        app_id: app.id,
        name,
        queued: true,
        timer: summary(queued),
        hint: 'The scheduler runs it within a minute. Then app_timer_list shows last_run_at and last_ok.',
      },
    };
  },
};

export const APP_TIMER_TOOLS: BuiltinToolDef[] = [
  app_timer_set,
  app_timer_list,
  app_timer_delete,
  app_timer_run,
];
