/**
 * Owner resolution for the single-user runtime.
 *
 * Mantle is single-user, but every background process (the agent, the email /
 * telegram / files / events / docs workers, the MCP server) needs to know
 * *whose* tree to operate on. Historically that came from the `ALLOWED_USER_ID`
 * env var, which had to be filled in by hand AFTER inserting the first row into
 * `auth.users` — a chicken-and-egg that made a from-scratch boot impossible
 * without manual SQL + an env edit + a restart.
 *
 * These helpers make that zero-config: when `ALLOWED_USER_ID` is unset, we
 * resolve the *sole* `auth.users` row at runtime. A fresh install can boot with
 * an empty DB; workers idle on `waitForOwner` until the first account is created
 * in the web app (signup), then pick it up with no restart.
 *
 * `ALLOWED_USER_ID` still wins when set — useful for scripts, or a future
 * multi-DB setup — and is validated as a UUID so a typo fails loud instead of
 * silently scoping every query to nothing.
 */
import { db } from './client';
import { authUsers } from './schema/auth-users';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Number of rows in auth.users. 0 ⇒ fresh install (signup is open). */
export async function countUsers(): Promise<number> {
  const rows = await db.select({ id: authUsers.id }).from(authUsers).limit(2);
  return rows.length;
}

/**
 * Resolve the owner this process should act for.
 * - `ALLOWED_USER_ID` set ⇒ that id (validated as a UUID; throws on garbage).
 * - else exactly one `auth.users` row ⇒ that id.
 * - else zero rows ⇒ `null` (no account yet — caller should wait).
 * - else more than one row ⇒ throws (single-user invariant violated; set
 *   `ALLOWED_USER_ID` to disambiguate).
 */
export async function resolveSingleOwnerId(): Promise<string | null> {
  const env = process.env.ALLOWED_USER_ID?.trim();
  if (env) {
    if (!UUID_RE.test(env)) {
      throw new Error(`ALLOWED_USER_ID '${env}' is not a valid UUID. Refusing to start.`);
    }
    return env;
  }
  const rows = await db.select({ id: authUsers.id }).from(authUsers).limit(2);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(
      'Multiple rows in auth.users but ALLOWED_USER_ID is not set. Mantle is single-user; ' +
        'set ALLOWED_USER_ID to choose which one this process serves.',
    );
  }
  return rows[0]!.id;
}

export type WaitForOwnerOpts = {
  /** Tag used in the log line, e.g. 'agent' or 'email-worker'. */
  label?: string;
  /** Poll interval while waiting for the first account. Default 3s. */
  intervalMs?: number;
};

/**
 * Block until an owner can be resolved, polling on a fresh install until the
 * first account is created. Logs once on entry and once on resolution so a
 * waiting worker is obvious in the logs without spamming. Returns the owner id.
 */
export async function waitForOwner(opts: WaitForOwnerOpts = {}): Promise<string> {
  const label = opts.label ?? 'worker';
  const intervalMs = opts.intervalMs ?? 3000;
  let logged = false;
  for (;;) {
    const id = await resolveSingleOwnerId();
    if (id) {
      if (logged) console.log(`[${label}] account found — owner ${id}`);
      return id;
    }
    if (!logged) {
      console.log(`[${label}] no account yet — waiting for first signup in the web app…`);
      logged = true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
