/**
 * Postgres error-code predicates for read paths that must survive a database
 * which cannot, or does not yet, do what the code assumed.
 *
 * Three GETs 500'd in one week for reasons unrelated to what was asked of them,
 * and all three were found by pointing a read-only database at the app rather
 * than by any test. They come in two shapes, and each needs a different answer:
 *
 *  1. An *opportunistic write on a read path* — a self-heal, a reconcile, a
 *     seed-if-missing. The read is still answerable; only the write is refused.
 *     → {@link isWriteRefused}
 *  2. An *optional subsystem assumed to be provisioned* — reading a journal that
 *     only exists where some other process created it. Nothing is wrong; the
 *     honest answer is "empty".
 *     → {@link isSubsystemMissing}
 *
 * ⚠️ **Pre-seeding rows does not help.** Postgres checks the table ACL when the
 * executor STARTS, before it matches a single row. An `INSERT … ON CONFLICT DO
 * NOTHING`, or an `UPDATE` whose `WHERE` matches nothing, is refused just the
 * same. The statement itself has to not run — which is why these are predicates
 * around a `try`, and not a cleverer query.
 *
 * Both walk the `cause` chain: drizzle wraps the driver error, so the code is
 * rarely on the object thrown.
 */

/** How far up a `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 4;

function hasCode(err: unknown, codes: ReadonlySet<string>): boolean {
  for (let e: unknown = err, depth = 0; e && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && codes.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `42501 insufficient_privilege` — the role may not write to this table.
 * `25006 read_only_sql_transaction` — the transaction (or server) is read-only.
 *
 * Deliberately narrow. Everything else is a real failure and must still surface:
 * swallowing a unique violation or a constraint error here would turn a bug into
 * silence, which is the failure mode this whole exercise exists to remove.
 */
const WRITE_REFUSED_CODES: ReadonlySet<string> = new Set(['42501', '25006']);

/** Did this error mean "the database refused to write", as opposed to "the write
 *  was wrong"? Use it to skip a self-heal and still serve the read. */
export function isWriteRefused(err: unknown): boolean {
  return hasCode(err, WRITE_REFUSED_CODES);
}

/**
 * `3F000 invalid_schema_name` and `42P01 undefined_table` — the subsystem's
 * tables were never created here. `42501` is included because a role narrowed to
 * least privilege reports "not allowed" for something it equally cannot see, and
 * from a reader's point of view those are the same answer.
 */
const SUBSYSTEM_MISSING_CODES: ReadonlySet<string> = new Set(['3F000', '42P01', '42501']);

/** Is this optional subsystem simply not provisioned on this deployment? An
 *  absent engine is an empty list, not an error. */
export function isSubsystemMissing(err: unknown): boolean {
  return hasCode(err, SUBSYSTEM_MISSING_CODES);
}
