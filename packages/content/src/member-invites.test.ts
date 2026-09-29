/**
 * The invite code without a database: its alphabet and its hash. The code
 * helpers moved here from the retired team-code module (migration 0178) and
 * must behave exactly as before: an invite made before 0178 stores the same
 * SHA-256 hex, and still redeems. The redeem is proven on Postgres in
 * member-invites.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  INVITE_CODE_ALPHABET,
  MEMBER_INVITE_CODE_LENGTH,
  generateInviteCode,
  hashInviteCode,
  inviteLinkPath,
} from './member-invites';
import { clientSigninLinkPath } from './client-logins';

describe('generateInviteCode', () => {
  it('produces codes of the fixed length', () => {
    expect(MEMBER_INVITE_CODE_LENGTH).toBe(16);
    for (let i = 0; i < 50; i++) {
      expect(generateInviteCode()).toHaveLength(MEMBER_INVITE_CODE_LENGTH);
    }
  });

  it('never emits look-alike characters (0/O/o, 1/l/I)', () => {
    expect(INVITE_CODE_ALPHABET).toHaveLength(54);
    const banned = /[0Oo1lI]/;
    expect(INVITE_CODE_ALPHABET).not.toMatch(banned);
    for (let i = 0; i < 200; i++) {
      expect(generateInviteCode()).not.toMatch(banned);
    }
  });

  it('stays within the mixed-case alphanumeric alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateInviteCode()).toMatch(/^[A-Za-z2-9]+$/);
    }
  });

  it('draws every character equally often', () => {
    // 20,000 codes = 320,000 characters, about 5,926 per character (sd about
    // 77). The old cutoff (224 for 54 characters) put the first 8 about 20%
    // over; a band of 8% is about 6 sd, so an honest generator never trips it.
    const seen = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      for (const ch of generateInviteCode()) seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }
    const expected = (20_000 * MEMBER_INVITE_CODE_LENGTH) / INVITE_CODE_ALPHABET.length;
    expect(seen.size).toBe(INVITE_CODE_ALPHABET.length);
    for (const ch of INVITE_CODE_ALPHABET) {
      expect(Math.abs((seen.get(ch) ?? 0) - expected) / expected, ch).toBeLessThan(0.08);
    }
  });

  it('does not repeat (sanity check on entropy plumbing)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateInviteCode());
    expect(seen.size).toBe(1000);
  });
});

describe('hashInviteCode', () => {
  it('is the plain SHA-256 hex the invites have always stored', () => {
    // A fixed vector: a change of hash would strand every open invite.
    expect(hashInviteCode('AbCdEfGhJkMnPqRs')).toBe(
      'd91e2ba10b59bd12c84b50f87077978dc35c47f10007aaede8795cb264c0514c',
    );
  });

  it('differs across codes', () => {
    expect(hashInviteCode('AbCdEfGhJkMnPqRs')).not.toBe(hashInviteCode('AbCdEfGhJkMnPqRt'));
  });
});

describe('link paths (client logins audit B12)', () => {
  it('carry the code in the fragment, never the query, so no server log or Referer sees it', () => {
    const code = generateInviteCode();
    for (const [path, page] of [
      [inviteLinkPath(code), '/invite'],
      [clientSigninLinkPath(code), '/client-signin'],
    ] as const) {
      expect(path).toBe(`${page}#code=${code}`);
      const url = new URL(path, 'https://brain.example.invalid');
      expect(url.search).toBe('');
      expect(url.pathname).toBe(page);
      expect(new URLSearchParams(url.hash.slice(1)).get('code')).toBe(code);
    }
  });

  it('escapes a code that is not from the alphabet', () => {
    expect(inviteLinkPath('a+b/c')).toBe('/invite#code=a%2Bb%2Fc');
    expect(clientSigninLinkPath('a&b')).toBe('/client-signin#code=a%26b');
  });
});
