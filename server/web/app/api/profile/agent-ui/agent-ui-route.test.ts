/**
 * GET/PUT /api/profile/agent-ui (docs/agent-ui.md): the login's own agent UI
 * setting, off by default; a save names the login it was made as, and one
 * naming another login, or none, is a 403 `login-mismatch` that writes
 * nothing (as /api/profile/sounds). No database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  saved: [] as Array<{ loginId: string; patch: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth', () => ({
  anyLoginCaller: () => ({ loginId: LOGIN }),
}));

vi.mock('@mantle/content', () => ({
  loadPreferencesFor: async () => h.stored,
  savePreferencesFor: async (loginId: string, patch: Record<string, unknown>) => {
    h.saved.push({ loginId, patch });
    h.stored = { ...h.stored, ...patch };
    return h.stored;
  },
}));

const { GET, PUT } = await import('./route');

const put = (body: unknown) =>
  PUT(
    new Request('http://brain.invalid/api/profile/agent-ui', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  h.stored = {};
  h.saved = [];
});

describe('/api/profile/agent-ui', () => {
  it('is off until the login turns it on', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: false });
    h.stored = { agentUi: 'true' };
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });

  it("saves the login's own value", async () => {
    const res = await put({ enabled: true, loginId: LOGIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect(h.saved).toEqual([{ loginId: LOGIN, patch: { agentUi: true } }]);
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it('refuses a save naming another login, or none, and writes nothing', async () => {
    for (const body of [{ enabled: true, loginId: OTHER }, { enabled: true }]) {
      const res = await put(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'login-mismatch' });
    }
    expect(h.saved).toEqual([]);
  });

  it('a body without a boolean is 400', async () => {
    expect((await put({ enabled: 'yes', loginId: LOGIN })).status).toBe(400);
    expect(h.saved).toEqual([]);
  });
});
