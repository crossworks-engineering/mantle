/**
 * Whose live turn a turn id is (lib/turn-access.ts, docs/agent-ui.md
 * "Members"): a member's turn id names its login and is open to that login
 * only, whatever its role; any other id is open to an Admin user only, as
 * before. No database: whether the login is an Admin user is stood in.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./assistant-chat', () => ({
  chatAdmin: vi.fn(async (l: { asLogin: { admin?: boolean } }) => l.asLogin.admin === true),
}));

const { memberTurnId, memberTurnLogin, streamableKey, turnOpenTo } = await import('./turn-access');

const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';

const login = (loginId: string, admin = false) =>
  ({ loginId, ownerId: 'owner-1', asLogin: { admin } }) as never;

describe('member turn ids', () => {
  it('name their login, and nothing else is one', () => {
    expect(memberTurnId(MEMBER, KEY)).toBe(`ws-${MEMBER}.${KEY}`);
    expect(memberTurnLogin(memberTurnId(MEMBER, KEY))).toBe(MEMBER);
    expect(memberTurnLogin(`WS-${MEMBER.toUpperCase()}.${KEY}`)).toBe(MEMBER);
    expect(memberTurnLogin(KEY)).toBeNull();
    expect(memberTurnLogin(`ws-${MEMBER}`)).toBeNull();
    expect(memberTurnLogin(`ws-${MEMBER}.`)).toBeNull();
    expect(memberTurnLogin(`ws-not-a-login.${KEY}`)).toBeNull();
    expect(memberTurnLogin(`ws-${MEMBER}.a/b`)).toBeNull();
  });

  it('an Idempotency-Key in their namespace never names a stream', () => {
    expect(streamableKey(KEY)).toBe(true);
    expect(streamableKey(`ws-${MEMBER}.${KEY}`)).toBe(false);
    expect(streamableKey('WS-anything')).toBe(false);
  });
});

describe('turnOpenTo', () => {
  it("a member's own turn: open to it", async () => {
    expect(await turnOpenTo(memberTurnId(MEMBER, KEY), login(MEMBER))).toBe(true);
  });

  it("another member's turn: closed, to a member and to an Admin user alike", async () => {
    expect(await turnOpenTo(memberTurnId(MEMBER, KEY), login(OTHER))).toBe(false);
    expect(await turnOpenTo(memberTurnId(MEMBER, KEY), login(ADMIN, true))).toBe(false);
    // A malformed id in the namespace is nobody's.
    expect(await turnOpenTo(`ws-${MEMBER}`, login(MEMBER))).toBe(false);
  });

  it("an Admin user's turn (any other id): open to an Admin user, closed to a member", async () => {
    expect(await turnOpenTo(KEY, login(ADMIN, true))).toBe(true);
    expect(await turnOpenTo(KEY, login(MEMBER))).toBe(false);
    expect(await turnOpenTo('turn-1', login(OTHER))).toBe(false);
  });
});
