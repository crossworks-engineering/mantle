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
import { findDatabaseError } from '@mantle/std';

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
 * A write the workspace checks refused (42501 with one of their own
 * messages): an Admin user's move, create in a folder or delete of an item
 * its workspaces may not change (0241, 0245, 0266, W6a fix round 1); a
 * change to, or a share of, a read-only snapshot copy (0267, W6b fix round
 * 1); the create home's refusals (mantle_default_home, 0267); the write
 * role's own checks (0278, 0279: edit, create, grant, a kind change, an
 * app's placement) and its row rule ("new row violates row-level security
 * policy", a row moved out of what the scope reads; arch A2b2b); the edit
 * check's (arch A3a, 0280 and 0281), which also carry a detail the mapper
 * reads (editRefusalDetail). Matched by message too, so a missing grant
 * (also 42501, isPermissionGap) stays a 500.
 */
export function isScopeWriteRefusal(err: unknown): boolean {
  const pg = findPgError(err) as (PgLike & { message?: unknown }) | null;
  if (!pg || pg.code !== '42501') return false;
  const message = typeof pg.message === 'string' ? pg.message : '';
  return SCOPE_WRITE_REFUSALS.test(message);
}

/** The details of the edit check's refusals (plan 5.2): the caller may not
 *  read the item, may read but not change it, the item is read only
 *  (Informational), or the caller only reads (a read key, a link, an
 *  assistant with no user). */
export type EditRefusalDetail = 'no_read' | 'no_edit' | 'read_only' | 'ro_actor';

const EDIT_REFUSAL_DETAILS: ReadonlySet<string> = new Set([
  'no_read',
  'no_edit',
  'read_only',
  'ro_actor',
]);

/** A folder move or delete refused because the folder holds rows the
 *  caller cannot read (mantle_subtree_refuse_hidden, 0282): a 409. */
export function isHiddenRowsRefusal(err: unknown): boolean {
  const pg = findPgError(err) as (PgLike & { detail?: unknown }) | null;
  return !!pg && pg.code === '42501' && pg.detail === 'hidden_rows';
}

/** The words a person sees for it (HTTP and the tools). */
export { HIDDEN_ROWS_PUBLIC as HIDDEN_ROWS_MESSAGE } from '@mantle/std';

/** The detail of an edit check refusal (42501 with one of the details
 *  above, mantle_edit_refuse), else null. */
export function editRefusalDetail(err: unknown): EditRefusalDetail | null {
  const pg = findPgError(err) as (PgLike & { detail?: unknown }) | null;
  if (!pg || pg.code !== '42501' || typeof pg.detail !== 'string') return null;
  return EDIT_REFUSAL_DETAILS.has(pg.detail) ? (pg.detail as EditRefusalDetail) : null;
}

/** The messages of the database's own write refusals (isScopeWriteRefusal). */
const SCOPE_WRITE_REFUSALS = new RegExp(
  '^(' +
    [
      'not allowed to (move this item|add items to that folder|delete this item|change this item' +
        '|share this item|edit this item|create an item in that workspace|grant to that workspace' +
        "|change the kind of this item|change anything|change this app's|write this app's)",
      'This folder holds items you cannot move',
      'placing this app adds a workspace you do not moderate',
      'this kind of item lives in the Admin workspace only',
      'no workspace to create this item in',
      'new row violates row-level security policy',
    ].join('|') +
    ')',
);

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
