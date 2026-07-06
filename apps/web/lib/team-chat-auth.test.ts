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

describe('team turn id prefix', () => {
  it('only team- prefixed ids are team turn ids', async () => {
    const { isTeamTurnId } = await import('./team-chat-gate');
    expect(isTeamTurnId('team-2f9c1f8e-1111-4222-8333-abcdefabcdef')).toBe(true);
    expect(isTeamTurnId('2f9c1f8e-1111-4222-8333-abcdefabcdef')).toBe(false);
    expect(isTeamTurnId('team-')).toBe(false);
    expect(isTeamTurnId('')).toBe(false);
  });
});
