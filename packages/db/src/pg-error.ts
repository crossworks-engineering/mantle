/**
 * Read the Postgres SQLSTATE off a thrown error, wherever it sits.
 *
 * Drizzle wraps every driver error from its query builder in a
 * DrizzleQueryError: the top message is "Failed query: <sql>\nparams: ...",
 * it carries no `code`, and the postgres-js error (with `.code`, `.detail`,
 * `.constraint_name`) is its `.cause`. A raw postgres-js tagged query throws
 * the driver error itself. So a check for `err.code === '23505'`, or for
 * "duplicate key" / a constraint name in the MESSAGE, silently never matches
 * on a drizzle query, and a duplicate turns into a 500 (seen 2026-09-29 on
 * POST /api/users and /api/keys, and in the rfc_message_id backfill).
 *
 * These helpers walk the error and up to three causes below it.
 */
const MAX_DEPTH = 4;

/** A five-character SQLSTATE, e.g. '23505'. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

type PgLike = { code?: unknown; constraint_name?: unknown; cause?: unknown };

/** The first error on the chain that carries a Postgres SQLSTATE. */
function findPgError(err: unknown): PgLike | null {
  let e: unknown = err;
  for (let depth = 0; depth < MAX_DEPTH && e && typeof e === 'object'; depth += 1) {
    const code = (e as PgLike).code;
    if (typeof code === 'string' && SQLSTATE_RE.test(code)) return e as PgLike;
    e = (e as PgLike).cause;
  }
  return null;
}

/** The first Postgres SQLSTATE on the error or its cause chain, else null. */
export function pgErrorCode(err: unknown): string | null {
  return (findPgError(err)?.code as string | undefined) ?? null;
}

/** The constraint or index Postgres named on that same error, else null.
 *  Lets a caller with two unique rules on one table say which one it hit. */
export function pgConstraint(err: unknown): string | null {
  const name = findPgError(err)?.constraint_name;
  return typeof name === 'string' ? name : null;
}

/** 23505 unique_violation: the write hit a unique index or constraint. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

/** 23514 check_violation: the write broke a CHECK constraint. */
export function isCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23514';
}

/** 40P01 deadlock_detected or 55P03 lock_not_available (a lock_timeout):
 *  another write held what this one needed. Safe to retry once; never to
 *  show a person as SQL (folder audit review F7). */
export function isBusy(err: unknown): boolean {
  if (err instanceof BusyError) return true;
  const code = pgErrorCode(err);
  return code === '40P01' || code === '55P03';
}

/** What a person reads when a write met another write on the same rows. */
export const BUSY_MESSAGE = 'Another change to these folders is under way; try again in a moment.';

/** The same for an item save (a page, note or drawing). */
export const SAVE_BUSY_MESSAGE = 'Another change to this item is under way; try again in a moment.';

/** A write that met another on the same rows twice: its message is for
 *  people, never SQL. isBusy() is true for it (the API answers 409). */
export class BusyError extends Error {
  constructor(message: string = SAVE_BUSY_MESSAGE) {
    super(message);
    this.name = 'BusyError';
  }
}

/**
 * Run a write once more when another write held its rows (a deadlock broken
 * by Postgres, or a lock timeout): its transaction rolled back whole, so the
 * second run starts clean. Busy again: a BusyError. Item saves take row
 * locks in the embed triggers (migration 0208) that a folder unshare may
 * hold in the other order.
 */
export async function withBusyRetry<T>(
  run: () => Promise<T>,
  message: string = SAVE_BUSY_MESSAGE,
): Promise<T> {
  try {
    return await run();
  } catch (first) {
    if (!isBusy(first)) throw first;
    try {
      return await run();
    } catch (err) {
      if (isBusy(err)) throw new BusyError(message);
      throw err;
    }
  }
}
