import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/team/sso — the bearer→cookie handoff. What must hold:
 *   - a valid signed team-chat bearer + a well-formed /s/<token> `next` mints
 *     a fresh cookie and 303s to the share;
 *   - `next` is a SINGLE /s path segment — every open-redirect shape is 403;
 *   - a foreign/garbage/wrong-kind bearer or dead membership is 401;
 *   - a cross-origin Origin that isn't ours is 403 (login-CSRF hardening).
 * Membership liveness is mocked — this is the route contract, not the DB.
 */

const isTeamMember = vi.fn(async () => true);
vi.mock('@mantle/content', () => ({
  isTeamMember: () => isTeamMember(),
}));

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-48chars!!';
});

let ipCounter = 0;
async function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const { handleTeamSso } = await import('./team-sso');
  const body = new URLSearchParams(fields);
  // Unique IP per call keeps the per-IP rate limiter out of these tests.
  ipCounter += 1;
  return handleTeamSso(
    new Request('http://server.test/api/team/sso', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': `10.0.0.${ipCounter}`,
        'x-forwarded-proto': 'http', // requestOrigin defaults non-localhost hosts to https
        host: 'server.test',
        ...headers,
      },
    }),
  );
}

async function mintBearer(): Promise<string> {
  const { buildTeamChatToken } = await import('./auth');
  return buildTeamChatToken('owner-1', 'contact-9').value;
}

describe('POST /api/team/sso', () => {
  it('valid bearer + valid next → 303 with a fresh team-chat cookie', async () => {
    isTeamMember.mockResolvedValue(true);
    const res = await post({ tb: await mintBearer(), next: '/s/Xk3mP2vQ' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://server.test/s/Xk3mP2vQ');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mantle_team_chat=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  it('rejects every open-redirect shape of next with 403', async () => {
    isTeamMember.mockResolvedValue(true);
    const tb = await mintBearer();
    for (const next of [
      '/evil',
      'https://evil.example/s/tok',
      '//evil.example/s/tok',
      '/s/tok/deeper',
      '/s/',
      '/s/tok?x=1',
      '/s/tok#frag',
      '\\s\\tok',
      '',
    ]) {
      const res = await post({ tb, next });
      expect(res.status, `next=${JSON.stringify(next)}`).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('rejects garbage and wrong-kind bearers with 401', async () => {
    isTeamMember.mockResolvedValue(true);
    const { buildTeamVisitorCookie, buildMobileToken } = await import('./auth');
    for (const tb of [
      'garbage',
      buildTeamVisitorCookie('share-1', 'contact-9').value, // k:'t'
      buildMobileToken('owner-1', 'jti-1', 3600).value, // k:'m'
    ]) {
      const res = await post({ tb, next: '/s/Xk3mP2vQ' });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('rejects a revoked membership with 401 (liveness is never skipped)', async () => {
    isTeamMember.mockResolvedValue(false);
    const res = await post({ tb: await mintBearer(), next: '/s/Xk3mP2vQ' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a foreign Origin with 403, allows our own origins', async () => {
    isTeamMember.mockResolvedValue(true);
    const tb = await mintBearer();
    const evil = await post({ tb, next: '/s/Xk3mP2vQ' }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);

    const sameOrigin = await post({ tb, next: '/s/Xk3mP2vQ' }, { origin: 'http://server.test' });
    expect(sameOrigin.status).toBe(303);

    process.env.MANTLE_CLIENT_ORIGIN = 'http://client.test';
    const clientOrigin = await post({ tb, next: '/s/Xk3mP2vQ' }, { origin: 'http://client.test' });
    expect(clientOrigin.status).toBe(303);
    delete process.env.MANTLE_CLIENT_ORIGIN;
  });
});
