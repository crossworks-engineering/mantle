/**
 * PUT /api/profile/sounds names the login the choice was made as
 * (`loginId`), as the Desk's save does: a save for any other login, or one
 * naming none, is a 403 with code `login-mismatch` and writes nothing, so a
 * tab left on one login never writes another's sounds after the browser
 * switched logins.
 *
 * No database: the login reader and the profile row are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  saved: [] as Array<{ loginId: string; patch: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth', () => ({
  anyLoginCaller: () => ({ loginId: LOGIN }),
}));

vi.mock('@mantle/content', () => ({
  loadPreferencesFor: async () => ({}),
  savePreferencesFor: async (loginId: string, patch: Record<string, unknown>) => {
    h.saved.push({ loginId, patch });
    return patch;
  },
}));

const { PUT } = await import('./route');

const put = (body: unknown) =>
  PUT(
    new Request('http://brain.invalid/api/profile/sounds', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const SOUNDS = { enabled: true, volume: 0.5 };

beforeEach(() => {
  h.saved = [];
});

describe('PUT /api/profile/sounds', () => {
  it('saves when loginId is the login of this session', async () => {
    const res = await put({ sounds: SOUNDS, loginId: LOGIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sounds: SOUNDS });
    expect(h.saved).toEqual([{ loginId: LOGIN, patch: { sounds: SOUNDS } }]);
  });

  it('refuses a save naming another login, and writes nothing', async () => {
    const res = await put({ sounds: SOUNDS, loginId: OTHER });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'loginId is not the login of this session',
      code: 'login-mismatch',
    });
    expect(h.saved).toEqual([]);
  });

  it('refuses a save naming no login, as one naming another', async () => {
    const res = await put({ sounds: SOUNDS });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'login-mismatch' });
    expect(h.saved).toEqual([]);
  });

  it('still answers 400 for a bad body before the login check', async () => {
    const res = await put({ sounds: { enabled: 'yes' }, loginId: OTHER });
    expect(res.status).toBe(400);
    expect(h.saved).toEqual([]);
  });
});
