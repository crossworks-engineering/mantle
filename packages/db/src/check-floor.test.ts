/**
 * The processes' warning while a check is below on (check-floor.ts,
 * migration 0301): pure.
 */
import { describe, expect, it } from 'vitest';
import { checkFloorWarning, loweredCovers } from './check-floor';

describe('checkFloorWarning', () => {
  it('says nothing when both checks are on, or for no row', () => {
    expect(checkFloorWarning({ actor: 'on', edit: 'on', lowered: '' })).toBe('');
    expect(checkFloorWarning(undefined)).toBe('');
  });

  it('names each check below on, the record, and the statements that put them back', () => {
    const line = checkFloorWarning({
      actor: 'on',
      edit: 'warn',
      lowered: '2026-10-16T10:00:00Z mantle.edit_check on to warn by postgres: an import',
    });
    expect(line).toMatch(/^\[db\] SECURITY: the edit check is warn on this brain\./);
    expect(line).toContain(
      'Lowered by an operator: 2026-10-16T10:00:00Z mantle.edit_check on to warn by postgres: an import.',
    );
    expect(line).toContain("select mantle_set_edit_check('on');");
    expect(line).not.toContain('mantle_set_actor_check');
  });

  it('a box below on with no record: migrate raises it', () => {
    const line = checkFloorWarning({ actor: 'off', edit: null, lowered: '' });
    expect(line).toMatch(/the actor check is off and the edit check is off/);
    expect(line).toContain('No reason is recorded');
    expect(line).toContain(
      "select mantle_set_actor_check('on'); select mantle_set_edit_check('on');",
    );
  });
});

describe('loweredCovers', () => {
  const rec =
    '2026-10-16T10:00:00Z mantle.edit_check on to warn by postgres: an import | ' +
    '2026-10-16T10:05:00Z mantle.actor_check kept at off by postgres: MANTLE_CHECK_FLOOR=keep at migrate, x';
  it('an entry covers its check at its recorded mode and above, never below', () => {
    expect(loweredCovers(rec, 'edit', 'warn')).toBe(true);
    expect(loweredCovers(rec, 'edit', 'off')).toBe(false);
    expect(loweredCovers(rec, 'actor', 'off')).toBe(true);
    expect(loweredCovers(rec, 'actor', 'warn')).toBe(true);
  });
  it('no record, or no entry for that check, covers nothing', () => {
    expect(loweredCovers('', 'edit', 'warn')).toBe(false);
    expect(loweredCovers(undefined, 'actor', 'off')).toBe(false);
    expect(
      loweredCovers('2026-10-16T10:00:00Z mantle.edit_check on to warn by p: x', 'actor', 'warn'),
    ).toBe(false);
    // A reason that names the other check does not cover it.
    expect(
      loweredCovers(
        '2026-10-16T10:00:00Z mantle.edit_check on to off by p: 1 mantle.actor_check on to off by p',
        'actor',
        'off',
      ),
    ).toBe(false);
  });
});
