/**
 * Migrate's warning about the narrow role's login (migrator-steps.ts
 * narrowLoginWarning): with the narrow switch on and the roles step not
 * run (not a superuser, a server before Postgres 16), the log names the
 * cause and the per-box kill switch; with the switch off or the step run,
 * nothing. beforeMigrations writes it to the log's warnings.
 */
import { describe, expect, it } from 'vitest';
import { narrowLoginWarning } from './migrator-steps';

describe('the narrow login warning at migrate', () => {
  it('warns with the switch on and the roles step not run, naming the cause and MANTLE_NARROW_SYSTEM=0', () => {
    const notSuper = narrowLoginWarning('not-superuser', true);
    expect(notSuper).toMatch(/^ {2}WARNING MANTLE_NARROW_SYSTEM is on/);
    expect(notSuper).toContain('migrate does not run as a superuser');
    expect(notSuper).toContain('MANTLE_NARROW_SYSTEM=0');
    expect(notSuper).toContain('docker compose up -d');
    expect(narrowLoginWarning('old-server', true)).toContain('older than Postgres 16');
  });

  it('says nothing with the switch off or the roles step run', () => {
    expect(narrowLoginWarning('not-superuser', false)).toBeNull();
    expect(narrowLoginWarning('old-server', false)).toBeNull();
    expect(narrowLoginWarning('ok', true)).toBeNull();
    expect(narrowLoginWarning('ok', false)).toBeNull();
  });
});
