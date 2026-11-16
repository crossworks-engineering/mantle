/**
 * The one door from a picture of an app (app_render) to the brain: every
 * `@host` bridge request the app makes while it is drawn is answered here,
 * and only here (app-render/sidecar.ts relays them; nothing else in the
 * render reaches data).
 *
 * A picture never writes. This is an allowlist, and its default is a
 * refusal: a call kind not named below is refused, whatever it is. The one
 * call that reads data, `db.query`, runs on the app's own SQLite opened
 * read-only by the engine (appDbReadQuery, the path app_db_query uses), so no
 * SQL a query sends can change a row, and it creates nothing (no registry
 * row, no file, no viewer salt). `host.me()` is baked into the frame, not
 * asked here.
 *
 * Refused in a picture: `db.exec`, `db.batch` (writes), `hub.get` (a picture
 * is no team hub) and every `tool.call` (owner decision 2026-11-16: a tool's
 * "read" is a policy mark across hundreds of tools and outside ones; running
 * them would need the tool broker's whole plan a second time). To let a read
 * run later, add a case here; the default stays a refusal.
 */
import { asSystem } from '@mantle/db';
import { appDbReadQuery } from '@mantle/content/app-broker';
import type { AppViewerSubject } from '@mantle/content/app-broker';
import { publicErrorText } from '@mantle/std';
import type { AppRenderHostAnswer } from '../app-render-bridge';

/** Who the picture is drawn for, and of which app. */
export type RenderHostContext = {
  ownerId: string;
  appId: string;
  /** The caller: fills `:host_me_*` as it would in the live app. */
  viewer: AppViewerSubject;
  /** One statement at a time per caller, shared with its live runs. */
  callerKey: string;
};

/** The longest SQL text and the most bound values a query may send (the
 *  app data tools' caps). */
const SQL_MAX = 100_000;
const PARAMS_MAX = 1000;
/** The longest answer a picture passes back to the app, as JSON. */
export const RENDER_ANSWER_MAX_CHARS = 2_000_000;

/** The refusal of a call a picture does not run. */
export function renderRefusal(label: string): AppRenderHostAnswer {
  return {
    ok: false,
    error: `Not in a picture: app_render only reads, so it does not run ${label}. The live app runs it.`,
    reason: 'render',
    refused: label.slice(0, 120),
  };
}

/** A short label for a call kind (and a tool's slug), for the report. */
function labelOf(kind: string, message: Record<string, unknown>): string {
  const k = /^[\w.]{1,40}$/.test(kind) ? kind : 'an unknown call';
  if (k !== 'tool.call') return k;
  const slug = typeof message.slug === 'string' ? message.slug : '';
  return /^[\w-]{1,80}$/.test(slug) ? `tool.call ${slug}` : 'tool.call';
}

/**
 * The app's database and its registry are read on the system pool after the
 * tool found the app in the caller's own scope, by the named reason
 * 'app-data' (AS_SYSTEM_TURN_REASONS): the same door the app data tools and
 * the member broker use. The read itself is read-only either way.
 */
function appDataSystem<T>(fn: () => Promise<T>): Promise<T> {
  return asSystem(fn, 'app-data');
}

async function dbQuery(
  ctx: RenderHostContext,
  message: Record<string, unknown>,
): Promise<AppRenderHostAnswer> {
  const sql = message.sql;
  const params = message.params ?? [];
  if (typeof sql !== 'string' || !sql.trim() || sql.length > SQL_MAX) {
    return { ok: false, error: 'host.db.query takes one SQL statement as text.' };
  }
  if (!Array.isArray(params) || params.length > PARAMS_MAX) {
    return { ok: false, error: 'host.db.query takes its values as an array.' };
  }
  try {
    const { rows } = await appDataSystem(() =>
      appDbReadQuery(ctx.ownerId, ctx.appId, sql, params as unknown[], {
        viewer: ctx.viewer,
        callerKey: ctx.callerKey,
      }),
    );
    return { ok: true, output: rows };
  } catch (err) {
    // The app sees the reason (its own SQL, mostly), as in the live app.
    return { ok: false, error: publicErrorText(err, 'app_render').slice(0, 500) };
  }
}

/** Answer one bridge request. Never throws. */
export async function answerRenderHostCall(
  ctx: RenderHostContext,
  message: Record<string, unknown>,
): Promise<AppRenderHostAnswer> {
  const kind = typeof message.kind === 'string' ? message.kind : '';
  switch (kind) {
    case 'db.query':
      return dbQuery(ctx, message);
    default:
      return renderRefusal(labelOf(kind, message));
  }
}
