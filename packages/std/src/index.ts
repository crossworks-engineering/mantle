import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * @mantle/std — the four helpers every package used to carry its own copy of
 * (2026-09-02 audit, sloppiness A7): the error-to-message idiom appeared 322
 * times inline, the UUID regex 21 times, `sleep` twice by name and a dozen
 * times inline. No package dependencies (node:async_hooks only); safe to
 * import from anywhere in the server tree. The published contract packages (client-types, content-core,
 * share-ui, voice-client) stay dependency-free and are deliberately NOT
 * consumers.
 */

/**
 * Database errors seen while a caller outside the server is being served
 * (watchDatabaseErrors): errorMessage records the text it gives for one, so
 * a tool that turned the error into a string reply can still be caught at
 * the surface (publicToolError) without touching every tool.
 */
const dbErrorWatch = new AsyncLocalStorage<{ texts: string[] }>();

/** The message of anything thrown: an Error's message, else its string form. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const watch = dbErrorWatch.getStore();
  if (watch && text && isDatabaseError(err)) watch.texts.push(text);
  return text;
}

function databaseShaped(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { name?: unknown; code?: unknown; severity?: unknown };
  if (o.name === 'DrizzleQueryError') return true;
  return (
    typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code) && typeof o.severity === 'string'
  );
}

/** Drizzle's query error message, which carries the SQL and its parameters. */
const FAILED_QUERY_RE = /Failed query:/;

/**
 * Whether `err`'s message could carry database text: a Postgres error (a
 * five-character SQLSTATE `code` and a `severity`, as postgres.js reports
 * them) or a drizzle query error (its message carries the SQL and its
 * parameters), or an error wrapping one whose message repeats the database
 * text. A wrapper of our own whose message is its own (a friendly "busy, try
 * again" over a lock timeout) is not one: its text is safe to show.
 */
export function isDatabaseError(err: unknown): boolean {
  const outer: string[] = [];
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    if (databaseShaped(e)) {
      if (outer.length === 0) return true;
      const inner = (e as { message?: unknown }).message;
      return outer.some(
        (m) =>
          FAILED_QUERY_RE.test(m) ||
          (typeof inner === 'string' && inner !== '' && m.includes(inner)),
      );
    }
    const m = (e as { message?: unknown }).message;
    outer.push(typeof m === 'string' ? m : '');
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** What a caller outside the server may read of a database error. */
export const DATABASE_ERROR_PUBLIC =
  'the database could not run this request (the details are in the server log)';

/**
 * The message of `err` for a caller outside the server (a tool reply, an MCP
 * client): a database error never goes out as its own text, which can carry
 * SQL, parameters or (with a row rule in force) something about a row the
 * caller may not read (workspaces W3, defence in depth). Logged in full
 * under `where`. Anything else keeps its message.
 */
export function publicErrorMessage(err: unknown, where: string): string {
  if (!isDatabaseError(err)) return err instanceof Error ? err.message : String(err);
  console.error(`[${where}] database error:`, err);
  return DATABASE_ERROR_PUBLIC;
}

/**
 * Run `fn` (one tool call for a caller outside the server) and collect the
 * text of every database error errorMessage turned into a string during it.
 */
export async function watchDatabaseErrors<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; texts: readonly string[] }> {
  const store = { texts: [] as string[] };
  const value = await dbErrorWatch.run(store, fn);
  return { value, texts: store.texts };
}

/**
 * A tool's error text for a caller outside the server: generic when it
 * carries a database error's text (one collected by watchDatabaseErrors, or
 * drizzle's "Failed query"), else unchanged. Logged in full under `where`.
 */
export function publicToolError(text: string, texts: readonly string[], where: string): string {
  if (!FAILED_QUERY_RE.test(text) && !texts.some((t) => text.includes(t))) return text;
  console.error(`[${where}] database error in a tool reply:`, text);
  return DATABASE_ERROR_PUBLIC;
}

/** Canonical UUID shape (any version, either case). Postgres accepts both
 *  cases, so do we; anchor it and it is safe to use on untrusted input. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap a string at `max` characters, marking the cut with an ellipsis that
 * COUNTS toward the cap — so the result is never longer than `max`, which is
 * what a caller passing a column width or a column's storage limit needs.
 *
 * The 2026-09 audit counted five `truncate` definitions and called them
 * duplicates. Three were: this one. The other two are a different function that
 * reports whether it cut (see `capOutput` in @mantle/tools) and belong apart.
 * Callers that also want the text on one line flatten it first — the two that
 * do disagree about whether a run of spaces collapses, and neither should
 * silently change to suit the other.
 */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
