/**
 * Whether a peer's connection names its login to the builtins
 * (peerNamesNoLogin): it stays on the peer's login role until the role
 * follows Admin membership, because the Admin pair (role admin AND a user
 * of Admin) would name the login of a role admin outside Admin, a wider
 * answer. These cells hold the answer for the five logins and show where
 * the pair would differ.
 *
 * The caller is built as server/web/lib/mcp-auth.ts builds a peer's: `role`
 * is the login row's role; `peerByOwner` is the pair AND the login is the
 * anchor AND the anchor made the peer.
 */
import { describe, expect, it } from 'vitest';
import { peerNamesNoLogin, type McpCaller } from './login-surface';

const ANCHOR = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

type Login = { name: string; role: 'admin' | 'member'; adminMember: boolean };

const LOGINS: readonly Login[] = [
  { name: 'Admin user', role: 'admin', adminMember: true },
  { name: 'Admin user, keys area off', role: 'admin', adminMember: true },
  { name: 'role admin outside Admin', role: 'admin', adminMember: false },
  { name: 'role member inside Admin', role: 'member', adminMember: true },
  { name: 'member', role: 'member', adminMember: false },
];

const pair = (l: Login) => l.role === 'admin' && l.adminMember;

function peerCaller(
  l: Login,
  loginId: string,
  createdBy: string,
): Pick<McpCaller, 'via' | 'role' | 'peerByOwner'> {
  return {
    via: 'peer',
    role: l.role,
    peerByOwner: pair(l) && loginId === ANCHOR && createdBy === ANCHOR,
  };
}

/** What the pair form would answer: names no login for an Admin user's
 *  peer the owner did not register. */
function pairForm(l: Login, c: Pick<McpCaller, 'peerByOwner'>): boolean {
  return pair(l) && !c.peerByOwner;
}

describe('a peer names its login to the builtins by its login role', () => {
  const cases = [
    { bound: 'the anchor, made by the anchor', loginId: ANCHOR, createdBy: ANCHOR },
    { bound: 'the anchor, made by another login', loginId: ANCHOR, createdBy: OTHER },
    { bound: 'another login', loginId: OTHER, createdBy: ANCHOR },
  ] as const;

  const expected: Record<string, Record<string, boolean>> = {
    'Admin user': {
      'the anchor, made by the anchor': false,
      'the anchor, made by another login': true,
      'another login': true,
    },
    'Admin user, keys area off': {
      'the anchor, made by the anchor': false,
      'the anchor, made by another login': true,
      'another login': true,
    },
    'role admin outside Admin': {
      'the anchor, made by the anchor': true,
      'the anchor, made by another login': true,
      'another login': true,
    },
    'role member inside Admin': {
      'the anchor, made by the anchor': false,
      'the anchor, made by another login': false,
      'another login': false,
    },
    member: {
      'the anchor, made by the anchor': false,
      'the anchor, made by another login': false,
      'another login': false,
    },
  };

  for (const l of LOGINS) {
    for (const c of cases) {
      it(`${l.name}, a peer bound to ${c.bound}: ${expected[l.name]![c.bound] ? 'names no login' : 'names its login'}`, () => {
        const caller = peerCaller(l, c.loginId, c.createdBy);
        expect(peerNamesNoLogin(caller)).toBe(expected[l.name]![c.bound]);
      });
    }
  }

  it('the pair form differs only for the role admin outside Admin, and there it would name the login (wider)', () => {
    for (const l of LOGINS) {
      for (const c of cases) {
        const caller = peerCaller(l, c.loginId, c.createdBy);
        const same = peerNamesNoLogin(caller) === pairForm(l, caller);
        expect(same).toBe(l.name !== 'role admin outside Admin');
        if (!same) {
          expect(peerNamesNoLogin(caller)).toBe(true);
          expect(pairForm(l, caller)).toBe(false);
        }
      }
    }
  });

  it('an OAuth or key connection always names its login', () => {
    for (const via of ['oauth', 'key'] as const) {
      for (const role of ['admin', 'member'] as const) {
        expect(peerNamesNoLogin({ via, role, peerByOwner: false })).toBe(false);
      }
    }
  });
});
