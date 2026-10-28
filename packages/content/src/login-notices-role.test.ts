/**
 * Who is told login notices (toldLoginNotices): an enabled login that is
 * not an Admin user (mantle_login_is_admin, read with the row), as its
 * session is a member's (resolvedFor). These cells hold the answer for the
 * five logins, enabled and disabled, and name where it differs from the
 * role column it read before: only for the two role-drift logins, which
 * the membership definers never leave (mantle_role_drift is 0 on every
 * box).
 */
import { describe, expect, it } from 'vitest';
import { toldLoginNotices } from './login-notices';

type Login = { name: string; role: 'admin' | 'member'; adminMember: boolean };

const LOGINS: readonly Login[] = [
  { name: 'Admin user', role: 'admin', adminMember: true },
  { name: 'Admin user, keys area off', role: 'admin', adminMember: true },
  { name: 'role admin outside Admin', role: 'admin', adminMember: false },
  { name: 'role member inside Admin', role: 'member', adminMember: true },
  { name: 'member', role: 'member', adminMember: false },
];

const TOLD: Record<string, boolean> = {
  'Admin user': false,
  'Admin user, keys area off': false,
  'role admin outside Admin': true,
  'role member inside Admin': false,
  member: true,
};

/** The answer before: the role column (enabled, role member). */
const byRole = (l: Login, disabledAt: Date | null) => !disabledAt && l.role === 'member';

describe('login notices are told by Admin membership', () => {
  for (const l of LOGINS) {
    it(`${l.name}, enabled: ${TOLD[l.name] ? 'told' : 'not told'}`, () => {
      expect(toldLoginNotices({ adminMember: l.adminMember, disabledAt: null })).toBe(TOLD[l.name]);
    });
    it(`${l.name}, disabled: not told`, () => {
      expect(toldLoginNotices({ adminMember: l.adminMember, disabledAt: new Date(0) })).toBe(false);
    });
  }

  it('equal to the role column for every login whose role agrees with membership', () => {
    for (const l of LOGINS.filter((x) => (x.role === 'admin') === x.adminMember)) {
      for (const d of [null, new Date(0)]) {
        expect(toldLoginNotices({ adminMember: l.adminMember, disabledAt: d }), l.name).toBe(
          byRole(l, d),
        );
      }
    }
  });

  it('differs only for the two role-drift logins, as their sessions answer', () => {
    const differs = LOGINS.filter(
      (l) => byRole(l, null) !== toldLoginNotices({ adminMember: l.adminMember, disabledAt: null }),
    );
    expect(differs.map((l) => l.name)).toEqual([
      'role admin outside Admin',
      'role member inside Admin',
    ]);
    // Inside Admin it is an Admin session: told nothing now (narrower).
    expect(toldLoginNotices({ adminMember: true, disabledAt: null })).toBe(false);
    // Outside Admin it is a member session (resolvedFor, S8b): told its own
    // notices, which name only what that session reads.
    expect(toldLoginNotices({ adminMember: false, disabledAt: null })).toBe(true);
  });
});
