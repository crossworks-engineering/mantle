/**
 * One log line for a failed watcher sync, not a stack.
 *
 * Drizzle wraps the driver error: the top message is "Failed query: <the whole
 * INSERT> params: <every value>". For a file node the params carry the file's
 * cached text, so logging the error object dumped the SQL, a sermon's worth of
 * content and a stack for one refused row (seen 2026-09-28). The line an
 * operator needs is the Postgres reason, which sits on the cause.
 *
 * So: walk the cause chain, prefer the first error that carries a Postgres
 * SQLSTATE, and add its code and constraint name. Anything else falls back to
 * the top message, capped so a wrapped query can never flood the log.
 */
const MAX_LEN = 300;

type PgLike = { code?: unknown; constraint_name?: unknown; message?: unknown };

function isPgError(e: PgLike): boolean {
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code);
}

function cap(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_LEN ? `${one.slice(0, MAX_LEN)}…` : one;
}

export function describeError(err: unknown): string {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const pg = e as PgLike;
    if (isPgError(pg)) {
      const constraint = typeof pg.constraint_name === 'string' ? `, ${pg.constraint_name}` : '';
      return `${cap(String(pg.message ?? 'database error'))} (${String(pg.code)}${constraint})`;
    }
    e = (e as { cause?: unknown }).cause;
  }
  if (err instanceof Error) return cap(err.message);
  return cap(String(err));
}
