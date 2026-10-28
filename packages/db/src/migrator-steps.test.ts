/**
 * Migrate's warning about the narrow role's login (migrator-steps.ts
 * narrowLoginWarning): with the roles step not run (not a superuser, a
 * server before Postgres 16), the log names the cause; with the step run,
 * nothing. beforeMigrations writes it to the log's warnings.
 */
import { describe, expect, it } from 'vitest';
import { narrowLoginWarning } from './migrator-steps';

describe('the narrow login warning at migrate', () => {
  it('warns when the roles step did not run, naming the cause and the fix', () => {
    const notSuper = narrowLoginWarning('not-superuser');
    expect(notSuper).toMatch(/^ {2}WARNING the narrow role \(mantle_system_narrow\)/);
    expect(notSuper).toContain('migrate does not run as a superuser');
    expect(notSuper).toContain('superuser on Postgres 16 or later');
    expect(narrowLoginWarning('old-server')).toContain('older than Postgres 16');
  });

  it('says nothing when the roles step ran', () => {
    expect(narrowLoginWarning('ok')).toBeNull();
  });
});
