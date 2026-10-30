/**
 * Stand-ins for the guard sweep (a4-guard-sweep.test.ts): the API keys it
 * presents, the grants they verify to, and the one summary of a guard's
 * answer. Test support only: nothing in the server imports it.
 */
import type { LoginRole } from '@mantle/client-types/role-names';
import type { AccessKeyGrant } from '../lib/access-keys';

const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';

const row = (id: string, role: LoginRole) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner: false,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
  adminMember: id === ADMIN_ID,
  contactId: null,
  disabledAt: null,
  sessionEpoch: 0,
  mustChangePassword: false,
});

/** The key tokens the sweep presents. */
export const KEY_TOKENS = {
  read: 'mtlk_sweepread_0000000000000000000000000000',
  write: 'mtlk_sweepwrite_000000000000000000000000000',
  readArea: 'mtlk_sweepreadarea_000000000000000000000000',
  writeArea: 'mtlk_sweepwritearea_00000000000000000000000',
  member: 'mtlk_sweepmember_00000000000000000000000000',
  /** No key has this token (the more-credentials sweep). */
  unknown: 'mtlk_sweepunknown_0000000000000000000000000',
  /** A key that was revoked (the more-credentials sweep). */
  revoked: 'mtlk_sweeprevoked_0000000000000000000000000',
} as const;

/** The key tokens that verify to a refusal, and its reason (as
 *  verifyAccessKey answers a revoked key). */
export const KEY_REFUSALS: Record<string, { reason: 'revoked'; keyId: string }> = {
  [KEY_TOKENS.revoked]: { reason: 'revoked', keyId: '00000006-0000-4000-8000-0000000000a6' },
};

const grant = (
  n: number,
  loginId: string,
  role: LoginRole,
  access: AccessKeyGrant['access'],
  areas: AccessKeyGrant['areas'],
): AccessKeyGrant => ({
  id: `0000000${n}-0000-4000-8000-0000000000a${n}`,
  prefix: `sweep${n}`,
  name: `sweep key ${n}`,
  loginId,
  role,
  access,
  areas,
  riskyTools: [],
  createdBy: ADMIN_ID,
  login: row(loginId, role),
});

/** What each key token verifies to. */
export const KEY_GRANTS: Record<string, AccessKeyGrant> = {
  [KEY_TOKENS.read]: grant(1, ADMIN_ID, 'admin', 'read', null),
  [KEY_TOKENS.write]: grant(2, ADMIN_ID, 'admin', 'read_write', null),
  [KEY_TOKENS.readArea]: grant(3, ADMIN_ID, 'admin', 'read', ['pages']),
  [KEY_TOKENS.writeArea]: grant(4, ADMIN_ID, 'admin', 'read_write', ['pages', 'files']),
  [KEY_TOKENS.member]: grant(5, MEMBER_ID, 'member', 'read_write', null),
};

/** A guard's answer as the sweep records it: its fields, sorted, with
 *  nested objects flattened one level. */
export function summarize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  const flat: Record<string, unknown> = {};
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && prefix === '') {
        walk(v as Record<string, unknown>, `${k}.`);
      } else {
        flat[`${prefix}${k}`] = v;
      }
    }
  };
  walk(value as Record<string, unknown>, '');
  return JSON.stringify(
    Object.fromEntries(Object.entries(flat).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
}
