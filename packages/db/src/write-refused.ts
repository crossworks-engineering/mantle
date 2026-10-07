/**
 * Did the database REFUSE this write, as opposed to the write being wrong?
 *
 * Several read paths in this app perform an opportunistic write — a self-heal
 * reconcile, a seed of built-in rows — and then serve a read. That is fine
 * against a normal database and fatal against one that will not accept writes:
 * a read-only replica, a revoked grant, or the public demo's reader role. The
 * read then 500s for a reason that has nothing to do with what was asked for.
 *
 * Where the write is genuinely best-effort, callers use this to skip it and
 * carry on serving the read.
 *
 * Narrow on purpose — only the two ways Postgres says "I will not write":
 *   42501  insufficient_privilege     — the role has no INSERT/UPDATE right
 *   25006  read_only_sql_transaction  — the session or transaction is read-only
 *
 * Anything else still throws. A blanket catch here would hide broken queries,
 * which is a worse bug than the one this exists to fix. Drizzle wraps the
 * driver error, so the code can sit on the cause rather than the top object.
 */
const WRITE_REFUSED_CODES = new Set(['42501', '25006']);

export function isWriteRefused(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && WRITE_REFUSED_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * After a refusal, how long a site goes without trying its write again. A
 * database that refused one write refuses the next (a reader role stays a
 * reader), and each try is a failed statement in its log, on every read. One
 * that takes writes again (a replica promoted in place) is asked again after
 * this.
 */
export const WRITE_RETRY_AFTER_MS = 5 * 60_000;

type Site = { refusedAt: number | null; warned: boolean };
const sites = new Map<string, Site>();

/**
 * Run a write a READ makes for itself (a root row, a once-only move, a
 * last-seen stamp, a counter). On a database that refuses writes the write is
 * skipped and null is answered, so the read can be served. Narrow on purpose
 * (isWriteRefused): any other failure is a real one and still throws.
 *
 * `site` names what is skipped, one per call site. Each site remembers its own
 * last refusal (the write is then not tried for WRITE_RETRY_AFTER_MS) and
 * warns once per process, so a refused view counter never pauses another
 * site's writes on a database that takes those.
 */
export async function bestEffortWrite<T>(site: string, write: () => Promise<T>): Promise<T | null> {
  let state = sites.get(site);
  if (!state) sites.set(site, (state = { refusedAt: null, warned: false }));
  if (state.refusedAt !== null && Date.now() - state.refusedAt < WRITE_RETRY_AFTER_MS) return null;
  try {
    const result = await write();
    state.refusedAt = null;
    return result;
  } catch (err) {
    if (!isWriteRefused(err)) throw err;
    state.refusedAt = Date.now();
    if (!state.warned) {
      state.warned = true;
      console.warn(
        `[db] ${site}: the database refuses writes (a read-only database or a role ` +
          'without INSERT or UPDATE). The write is skipped and the read is served. ' +
          'Logged once per process.',
      );
    }
    return null;
  }
}

/** Forget every site's last refusal, so the next write is tried (tests). */
export function forgetWriteRefusals(): void {
  for (const state of sites.values()) state.refusedAt = null;
}
