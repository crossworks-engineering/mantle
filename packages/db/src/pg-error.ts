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
import { ConflictError, findDatabaseError } from '@mantle/std';

/** How deep isBusy looks for a BusyError on the cause chain. */
const MAX_DEPTH = 4;

type PgLike = { code?: unknown; constraint_name?: unknown; cause?: unknown };

/** The first error on the chain that carries a Postgres SQLSTATE: the one
 *  walk, findDatabaseError (@mantle/std), shared with databaseErrorPublic. */
function findPgError(err: unknown): PgLike | null {
  return findDatabaseError(err) as PgLike | null;
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

/**
 * A write the workspaces heads check refused (0241, plan V5): in 'on' mode a
 * writer that did not lock its heads first fails with 40001 "heads not held
 * ...", and a first lock taken after a write with 55000. Not transient: the
 * same code path fails the same way again, so a worker sends the job to its
 * dead letter at once instead of retrying (no LLM work runs twice).
 */
export function isHeadsCheckError(err: unknown): boolean {
  const pg = findPgError(err) as (PgLike & { message?: unknown }) | null;
  if (!pg || (pg.code !== '40001' && pg.code !== '55000')) return false;
  const message = typeof pg.message === 'string' ? pg.message : '';
  return /heads not held|mantle_lock_heads/.test(message);
}

/**
 * The database's refusals, read by THE one mapper (mapAccessError,
 * @mantle/std access-error.ts; arch A3c): a write a workspace check refused
 * (isScopeWriteRefusal), the edit check's detail (editRefusalDetail) and a
 * folder that holds rows the caller cannot read (isHiddenRowsRefusal). One
 * reading of each, there; re-exported here for the callers of @mantle/db.
 */
export {
  editRefusalDetail,
  isHiddenRowsRefusal,
  isScopeWriteRefusal,
  type EditRefusalDetail,
} from '@mantle/std';

/** The words a person sees for a hidden-rows refusal (HTTP and the tools). */
export { HIDDEN_ROWS_PUBLIC as HIDDEN_ROWS_MESSAGE } from '@mantle/std';

/**
 * A privilege the role lacks (42501 "permission denied for ..."): a table,
 * a column, a function, a sequence or a schema it holds no grant on. Never
 * a refusal a check or a row rule decided (those carry their own message).
 * The login write gateway (client.ts, arch A2b2b) notes every one, and
 * runs a write again only for a table of WRITE_ROLE_GAP_TABLES
 * (writeRoleGapTable, access-matrix.ts): any other is a bug, an error.
 */
export function isPermissionGap(err: unknown): boolean {
  return permissionGapOf(err) !== null;
}

/** The "permission denied for ..." message of a privilege gap, else null. */
export function permissionGapOf(err: unknown): string | null {
  const pg = findPgError(err) as (PgLike & { message?: unknown }) | null;
  if (!pg || pg.code !== '42501') return null;
  const message = typeof pg.message === 'string' ? pg.message : '';
  return /^permission denied for /.test(message) ? message.slice(0, 200) : null;
}

/** 23505 unique_violation: the write hit a unique index or constraint. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

/**
 * `fn`, with a unique violation (a slug or a name already taken) as a
 * ConflictError saying `message`: 409 `{ error: message }` by its row in the
 * one domain error table (A10 part 2 fix round 1, L7). The one place a route
 * says "already exists" for a write that raced or skipped a pre-check, where
 * 13 routes each caught it by hand.
 */
export async function conflictOnUnique<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(message, { cause: err });
    throw err;
  }
}

/** 23514 check_violation: the write broke a CHECK constraint. */
export function isCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23514';
}

/** 40P01 deadlock_detected or 55P03 lock_not_available (a lock_timeout):
 *  another write held what this one needed. Safe to retry once; never to
 *  show a person as SQL (folder audit review F7). */
export function isBusy(err: unknown): boolean {
  // Ours, or one a query builder wrapped (drizzle: the cause).
  let e: unknown = err;
  for (let depth = 0; depth < MAX_DEPTH && e && typeof e === 'object'; depth += 1) {
    if (e instanceof BusyError) return true;
    e = (e as PgLike).cause;
  }
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
