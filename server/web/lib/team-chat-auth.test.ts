import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Team-chat credential tests: the signed cookie roundtrip, tampering, and —
 * the one that really matters — KIND ISOLATION. Every signed token in auth.ts
 * carries a `k` discriminator; the team-chat verifier must reject the
 * app-share visitor cookie (k:'t') and vice versa, so neither external
 * credential can ever be replayed on the other surface.
 */

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-48chars!!';
});

async function authLib() {
  return import('./auth');
}

describe('team-chat cookie', () => {
  it('roundtrips owner + contact claims', async () => {
    const { buildTeamChatCookie, verifyTeamChatValue } = await authLib();
    const c = buildTeamChatCookie('owner-1', 'contact-9');
    expect(verifyTeamChatValue(c.value)).toEqual({ ownerId: 'owner-1', contactId: 'contact-9' });
  });

  it('rejects a tampered payload', async () => {
    const { buildTeamChatCookie, verifyTeamChatValue } = await authLib();
    const c = buildTeamChatCookie('owner-1', 'contact-9');
    const dot = c.value.lastIndexOf('.');
    const forged = `${Buffer.from(
      JSON.stringify({ own: 'owner-1', cid: 'contact-EVIL', exp: 9999999999, k: 'c' }),
    ).toString('base64url')}${c.value.slice(dot)}`;
    expect(verifyTeamChatValue(forged)).toBeNull();
  });

  it('rejects garbage and empty values', async () => {
    const { verifyTeamChatValue } = await authLib();
    expect(verifyTeamChatValue('')).toBeNull();
    expect(verifyTeamChatValue('not-a-token')).toBeNull();
    expect(verifyTeamChatValue('a.b')).toBeNull();
  });

  it('NEVER accepts an app-share visitor cookie (kind isolation, k:t vs k:c)', async () => {
    const { buildTeamVisitorCookie, verifyTeamChatValue } = await authLib();
    const shareCookie = buildTeamVisitorCookie('share-1', 'contact-9');
    expect(verifyTeamChatValue(shareCookie.value)).toBeNull();
  });

  it('is never accepted BY the app-share verifier either', async () => {
    const { buildTeamChatCookie, verifyTeamVisitorValue } = await authLib();
    const chatCookie = buildTeamChatCookie('owner-1', 'contact-9');
    expect(verifyTeamVisitorValue(chatCookie.value)).toBeNull();
  });
});

describe('team turn ids are contact-scoped (cross-member isolation)', () => {
  it('mints a team-<contactId>.<nonce> id and round-trips the contact', async () => {
    const { mintTeamTurnId, contactOfTeamTurnId, isTeamTurnId } = await import('./team-chat-gate');
    const id = mintTeamTurnId('contact-9', 'nonce-abcdef12');
    expect(id).toBe('team-contact-9.nonce-abcdef12');
    expect(contactOfTeamTurnId(id)).toBe('contact-9');
    expect(isTeamTurnId(id)).toBe(true);
  });

  it('falls back to a random nonce when the client nonce is missing or unsafe', async () => {
    const { mintTeamTurnId, contactOfTeamTurnId } = await import('./team-chat-gate');
    // Too short / contains a dot → rejected, server generates its own nonce.
    const a = mintTeamTurnId('contact-9', 'x');
    const b = mintTeamTurnId('contact-9', 'has.dot.chars');
    const c = mintTeamTurnId('contact-9');
    for (const id of [a, b, c]) {
      expect(contactOfTeamTurnId(id)).toBe('contact-9');
      expect(id.startsWith('team-contact-9.')).toBe(true);
    }
    // Distinct random nonces, and the injected dot never leaks a second segment.
    expect(a).not.toBe(c);
  });

  it('rejects owner turn ids (bare uuids) and malformed ids', async () => {
    const { contactOfTeamTurnId, isTeamTurnId } = await import('./team-chat-gate');
    expect(contactOfTeamTurnId('2f9c1f8e-1111-4222-8333-abcdefabcdef')).toBeNull();
    expect(contactOfTeamTurnId('team-')).toBeNull(); // no contact/nonce
    expect(contactOfTeamTurnId('team-contact-9')).toBeNull(); // no nonce separator
    expect(contactOfTeamTurnId('team-.nonce')).toBeNull(); // empty contact
    expect(contactOfTeamTurnId('team-contact-9.')).toBeNull(); // empty nonce
    expect(contactOfTeamTurnId('')).toBeNull();
    expect(isTeamTurnId('2f9c1f8e-1111-4222-8333-abcdefabcdef')).toBe(false);
  });

  it("a member's id never resolves to another member's contact", async () => {
    const { mintTeamTurnId, contactOfTeamTurnId } = await import('./team-chat-gate');
    // Even if a member sends victim's whole id as the nonce, the contact half is
    // server-set from THEIR credential — it can't address the victim's turn.
    const victimId = mintTeamTurnId('victim-contact', 'aaaaaaaa');
    const attackerId = mintTeamTurnId('attacker-contact', victimId);
    expect(contactOfTeamTurnId(attackerId)).toBe('attacker-contact');
  });
});
