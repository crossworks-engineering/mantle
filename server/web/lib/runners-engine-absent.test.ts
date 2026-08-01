import { describe, expect, it } from 'vitest';
import { isRunnerEngineAbsent } from './runners-engine';

/**
 * The Runners screen reads DBOS's system-database journal, which only exists
 * where the runner process created it. On a brain that never provisioned
 * runners — or one served by a read-only role, like the public demo — every
 * read threw and the screen 500'd. These are the exact codes that mean "not
 * available to you", and just as importantly the ones that must NOT be
 * swallowed: laundering a broken query into "no runs" would be
 * indistinguishable from a healthy idle queue.
 */
describe('isRunnerEngineAbsent', () => {
  it('recognises a role that cannot use the schema', () => {
    expect(isRunnerEngineAbsent({ code: '42501' })).toBe(true); // insufficient_privilege
  });

  it('recognises a missing schema and missing journal tables', () => {
    expect(isRunnerEngineAbsent({ code: '3F000' })).toBe(true); // invalid_schema_name
    expect(isRunnerEngineAbsent({ code: '42P01' })).toBe(true); // undefined_table
  });

  it('recognises a missing DATABASE, which is what a RESTORED brain reports', () => {
    // DBOS keeps its journal in a separate database (mantle_dbos_sys), and
    // pg_dump is per-database — so a brain restored from a bundle has no such
    // database and Postgres answers with a catalog-level code, not a schema
    // one. A provisioned cluster served by a read-only role says 42501 instead,
    // which is why this spelling of "absent" went unhandled until the deployed
    // demo hit it.
    expect(isRunnerEngineAbsent({ code: '3D000' })).toBe(true); // invalid_catalog_name
    expect(
      isRunnerEngineAbsent(
        new Error('database "mantle_dbos_sys" does not exist', { cause: { code: '3D000' } }),
      ),
    ).toBe(true);
  });

  it('unwraps a driver error carried as a cause', () => {
    expect(
      isRunnerEngineAbsent(new Error('listWorkflows failed', { cause: { code: '42501' } })),
    ).toBe(true);
  });

  it('does NOT swallow real failures', () => {
    expect(isRunnerEngineAbsent({ code: '57014' })).toBe(false); // query_canceled
    expect(isRunnerEngineAbsent({ code: '23505' })).toBe(false); // unique_violation
    expect(isRunnerEngineAbsent({ code: '08006' })).toBe(false); // connection_failure
    expect(isRunnerEngineAbsent(new Error('boom'))).toBe(false);
    expect(isRunnerEngineAbsent(null)).toBe(false);
  });
});
