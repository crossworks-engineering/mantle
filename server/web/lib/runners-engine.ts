/**
 * Is a failure "the runner engine isn't there for us", rather than a broken
 * query?
 *
 * The Runners screen reads DBOS's own system-database journal. That schema is
 * created by the runner process, so on a brain where runners were never
 * provisioned — or where the app connects with a role that cannot see the
 * schema, as a read-only replica or the public demo does — every read throws
 * and the screen 500s. An optional subsystem being absent is not an error on a
 * read path; it is an empty list.
 *
 * Kept in its own module with NO imports so it stays unit-testable: runners.ts
 * pulls in the DBOS client through the `@/` alias, which the test runner does
 * not resolve.
 */

/**
 * Narrow on purpose. Only the ways Postgres says "the engine's journal is not
 * available to you":
 *   42501  insufficient_privilege  — the role cannot use the schema
 *   3F000  invalid_schema_name     — the schema does not exist
 *   42P01  undefined_table         — schema exists, journal tables do not
 *   3D000  invalid_catalog_name    — the DATABASE does not exist
 *
 * 3D000 is the odd one out in a list otherwise about schemas, and it is here for
 * a reason that is easy to miss: DBOS keeps its journal in a separate DATABASE
 * (`mantle_dbos_sys`), not merely a separate schema. `pg_dump` is per-database,
 * so a brain RESTORED from a bundle has no such database at all — and "engine
 * absent" then presents as a catalog-level code rather than a schema-level one.
 *
 * That is why a provisioned cluster and a restored one disagree, which is what
 * hid this for so long:
 *   provisioned + read-only role  → 42501 → handled → empty screen
 *   restored, never provisioned   → 3D000 → 500 (until this line)
 *
 * Anything else is a real fault and must still throw. Laundering a broken query
 * into "no runs" would be indistinguishable from a healthy idle queue, which is
 * a worse bug than the 500 this replaces.
 */
const ENGINE_ABSENT_CODES = new Set(['42501', '3F000', '42P01', '3D000']);

export function isRunnerEngineAbsent(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && ENGINE_ABSENT_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
