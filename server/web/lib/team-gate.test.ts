import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /s team-mode share admission after the team portal retired (member logins
 * Phase 6). The share-scoped visitor cookie still admits a live team member;
 * the brain-level team-chat credential (cookie `mantle_team_chat`, or the same
 * signed value as a bearer from the client's retired /hub) no longer does,
 * even when it is correctly signed and the contact is still a member.
 */

const SECRET = 'test-secret-test-secret-test-secret-48chars!!';
const h = vi.hoisted(() => ({ member: true }));

vi.mock('@mantle/content', () => ({
  shareModeOf: (s: { mode?: string }) => s.mode ?? 'public',
  isTeamMember: vi.fn(async () => h.member),
}));

function signRaw(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', Buffer.from(SECRET)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

const share = { id: 'share-1', ownerId: 'owner-1', mode: 'team' } as never;
const exp = () => Math.floor(Date.now() / 1000) + 3600;

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});
beforeEach(() => {
  h.member = true;
});

describe('resolveShareVisitor', () => {
  it('admits a live member on the share-scoped visitor cookie', async () => {
    const { buildTeamVisitorCookie } = await import('./auth');
    const { resolveShareVisitor } = await import('./team-gate');
    const v = buildTeamVisitorCookie('share-1', 'contact-9').value;
    expect(await resolveShareVisitor(`mantle_team=${v}`, share)).toEqual({
      mode: 'team',
      contactId: 'contact-9',
    });
    h.member = false;
    expect(await resolveShareVisitor(`mantle_team=${v}`, share)).toBeNull();
  });

  it('refuses the retired team-chat cookie, signed and live', async () => {
    const { resolveShareVisitor } = await import('./team-gate');
    const chat = signRaw({ own: 'owner-1', cid: 'contact-9', exp: exp(), k: 'c' });
    expect(await resolveShareVisitor(`mantle_team_chat=${chat}`, share)).toBeNull();
  });

  it('refuses the retired team-chat value as a bearer on the broker path', async () => {
    const { resolveShareVisitorFromRequest } = await import('./team-gate');
    const chat = signRaw({ own: 'owner-1', cid: 'contact-9', exp: exp(), k: 'c' });
    const req = new Request('http://brain.test/s/tok/bundle', {
      headers: { authorization: `Bearer ${chat}` },
    });
    expect(await resolveShareVisitorFromRequest(req, share)).toBeNull();
  });

  it('still admits anyone on a public share', async () => {
    const { resolveShareVisitor } = await import('./team-gate');
    expect(
      await resolveShareVisitor(null, { ...(share as object), mode: 'public' } as never),
    ).toEqual({ mode: 'public', contactId: null });
  });
});
