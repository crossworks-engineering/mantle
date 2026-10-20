/**
 * Who is told login notices (toldLoginNotices): it stays on the login's
 * role until the role follows Admin membership, because "not an Admin user"
 * by the Admin pair (role admin AND a user of Admin) would tell a role admin
 * outside Admin its notices, a wider answer. These cells hold the answer
 * for the five logins, enabled and disabled, and show where the pair would
 * differ.
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

const pair = (l: Login) => l.role === 'admin' && l.adminMember;

/** What the pair form would answer: every enabled login but an Admin user. */
const pairForm = (l: Login, disabledAt: Date | null) => !disabledAt && !pair(l);

const TOLD: Record<string, boolean> = {
  'Admin user': false,
  'Admin user, keys area off': false,
  'role admin outside Admin': false,
  'role member inside Admin': true,
  member: true,
};

describe('login notices are told by the login role', () => {
  for (const l of LOGINS) {
    it(`${l.name}, enabled: ${TOLD[l.name] ? 'told' : 'not told'}`, () => {
      expect(toldLoginNotices({ role: l.role, disabledAt: null })).toBe(TOLD[l.name]);
    });
    it(`${l.name}, disabled: not told`, () => {
      expect(toldLoginNotices({ role: l.role, disabledAt: new Date(0) })).toBe(false);
    });
  }

  it('a role this code does not know, or none, is not told', () => {
    expect(toldLoginNotices({ role: 'client', disabledAt: null })).toBe(false);
    expect(toldLoginNotices({ role: undefined, disabledAt: null })).toBe(false);
    expect(toldLoginNotices({ role: null, disabledAt: null })).toBe(false);
  });

  it('the pair form differs only for the role admin outside Admin, where it is wider', () => {
    const differs = LOGINS.filter(
      (l) => pairForm(l, null) !== toldLoginNotices({ role: l.role, disabledAt: null }),
    );
    expect(differs.map((l) => l.name)).toEqual(['role admin outside Admin']);
    const drift = differs[0]!;
    expect(pairForm(drift, null)).toBe(true);
    expect(toldLoginNotices({ role: drift.role, disabledAt: null })).toBe(false);
    for (const l of LOGINS) {
      expect(pairForm(l, new Date(0))).toBe(
        toldLoginNotices({ role: l.role, disabledAt: new Date(0) }),
      );
    }
  });
});
