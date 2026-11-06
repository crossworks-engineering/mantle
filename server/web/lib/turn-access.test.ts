/**
 * Whose live turn a turn id is (lib/turn-access.ts, docs/agent-ui.md "Turn
 * ids"): every turn id names its login (`turn-` on the owner engine, `ws-`
 * on the workspace engine) and is open to that login only, whatever its
 * role; any other id is nobody's. No database.
 */
import { describe, expect, it } from 'vitest';
import {
  memberTurnId,
  memberTurnLogin,
  ownerTurnId,
  streamableKey,
  turnLogin,
  turnOpenTo,
} from './turn-access';

const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const ADMIN_A = '55555555-5555-4555-8555-555555555555';
const ADMIN_B = '66666666-6666-4666-8666-666666666666';
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';

const login = (loginId: string) => ({ loginId });

describe('turn ids', () => {
  it('a workspace turn id names its login, and nothing else is one', () => {
    expect(memberTurnId(MEMBER, KEY)).toBe(`ws-${MEMBER}.${KEY}`);
    expect(memberTurnLogin(memberTurnId(MEMBER, KEY))).toBe(MEMBER);
    expect(memberTurnLogin(`WS-${MEMBER.toUpperCase()}.${KEY}`)).toBe(MEMBER);
    expect(memberTurnLogin(KEY)).toBeNull();
    expect(memberTurnLogin(ownerTurnId(MEMBER, KEY))).toBeNull();
    expect(memberTurnLogin(`ws-${MEMBER}`)).toBeNull();
    expect(memberTurnLogin(`ws-${MEMBER}.`)).toBeNull();
    expect(memberTurnLogin(`ws-not-a-login.${KEY}`)).toBeNull();
    expect(memberTurnLogin(`ws-${MEMBER}.a/b`)).toBeNull();
  });

  it('an owner turn id names its login the same way', () => {
    expect(ownerTurnId(ADMIN_A, KEY)).toBe(`turn-${ADMIN_A}.${KEY}`);
    expect(turnLogin(ownerTurnId(ADMIN_A, KEY))).toBe(ADMIN_A);
    expect(turnLogin(`TURN-${ADMIN_A.toUpperCase()}.${KEY}`)).toBe(ADMIN_A);
    expect(turnLogin(memberTurnId(MEMBER, KEY))).toBe(MEMBER);
    expect(turnLogin(KEY)).toBeNull();
    expect(turnLogin(`turn-${ADMIN_A}`)).toBeNull();
    expect(turnLogin(`turn-${ADMIN_A}.a b`)).toBeNull();
    expect(turnLogin(`turn-1.${KEY}`)).toBeNull();
  });

  it('an Idempotency-Key in either namespace (any case), or not one path segment, never names a stream', () => {
    expect(streamableKey(KEY)).toBe(true);
    expect(streamableKey(`ws-${MEMBER}.${KEY}`)).toBe(false);
    expect(streamableKey('WS-anything')).toBe(false);
    expect(streamableKey(`turn-${ADMIN_A}.${KEY}`)).toBe(false);
    expect(streamableKey('Turn-anything')).toBe(false);
    expect(streamableKey('a/b')).toBe(false);
    expect(streamableKey('a b')).toBe(false);
    expect(streamableKey('')).toBe(false);
  });
});

describe('turnOpenTo', () => {
  it("a login's own turn, on either engine: open to it", () => {
    expect(turnOpenTo(memberTurnId(MEMBER, KEY), login(MEMBER))).toBe(true);
    expect(turnOpenTo(ownerTurnId(ADMIN_A, KEY), login(ADMIN_A))).toBe(true);
    expect(turnOpenTo(memberTurnId(ADMIN_A, KEY), login(ADMIN_A))).toBe(true);
    expect(turnOpenTo(ownerTurnId(ADMIN_A, KEY), login(ADMIN_A.toUpperCase()))).toBe(true);
  });

  it("another login's turn: closed, whoever asks", () => {
    expect(turnOpenTo(memberTurnId(MEMBER, KEY), login(OTHER))).toBe(false);
    expect(turnOpenTo(memberTurnId(MEMBER, KEY), login(ADMIN_A))).toBe(false);
    // Admin B never reaches Admin A's turn.
    expect(turnOpenTo(ownerTurnId(ADMIN_A, KEY), login(ADMIN_B))).toBe(false);
    expect(turnOpenTo(ownerTurnId(ADMIN_A, KEY), login(MEMBER))).toBe(false);
  });

  it("an id that names no login is nobody's: an Admin user's raw key included", () => {
    for (const who of [ADMIN_A, ADMIN_B, MEMBER]) {
      expect(turnOpenTo(KEY, login(who))).toBe(false);
      expect(turnOpenTo('turn-1', login(who))).toBe(false);
      expect(turnOpenTo(`ws-${who}`, login(who))).toBe(false);
    }
  });
});
