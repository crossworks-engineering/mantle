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
