/**
 * PUT /api/profile without a database: Settings → Profile saves the brain's
 * purpose under the same rule as onboarding. Over the limit is a 400 that
 * names it; the old silent `.slice(0, 600)` is gone.
 *
 * Through the full pipeline (runRoute, A4 step 3a): the gate finds the
 * stood-in owner's session, the guard reads it, the handler saves. No
 * credential is the gate's 401, and nothing is saved.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PURPOSE_MAX_CHARS } from '@mantle/client-types/purpose-limits';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const OWNER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  saved: [] as Array<Record<string, unknown>>,
  areas: [] as string[],
}));

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  savePreferencesFor: vi.fn(async (_id: string, p: Record<string, unknown>) => {
    h.saved.push(p);
    return {};
  }),
  loadPreferencesFor: vi.fn(async () => ({ siteName: 'Old', purpose: '', houseStyle: '' })),
}));

// The scope's answer for the Admin login (adminFacts): an Admin user with
// the areas the test sets.
vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn(async () => ({ admin: true, areas: new Set(h.areas) })),
}));

beforeAll(() => {
  standInLogin({ id: OWNER, role: 'admin', adminMember: true, isOwner: true });
  standInLogin({ id: ADMIN, role: 'admin', adminMember: true });
});

beforeEach(() => {
  h.saved = [];
  h.areas = [];
});

const put = (purpose: string, login: string | null = OWNER) =>
  runRoute(login, 'PUT', '/api/profile', { timezone: 'UTC', purpose });

describe('profile purpose', () => {
  it('saves a purpose at the limit', async () => {
    const text = 'p'.repeat(PURPOSE_MAX_CHARS);
    const res = await put(text);
    expect(res.status).toBe(200);
    expect(h.saved[0]?.purpose).toBe(text);
  });

  it('refuses a purpose over the limit and saves nothing', async () => {
    const res = await put('p'.repeat(PURPOSE_MAX_CHARS + 1));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('601');
    expect(h.saved).toEqual([]);
  });

  it('refuses a request with no session at the gate, and saves nothing', async () => {
    const res = await put('p', null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(h.saved).toEqual([]);
  });
});

describe('profile brand keys', () => {
  // The brand gate's rule and words (brandSettingsRefusal, the scope's
  // answer), as the other /api/profile brand writers say them; this route
  // once said its own sentence ("The brain's own settings (...) are changed
  // by the brain owner or a user with the settings area.").
  it('another Admin login without the settings area: the brand gate refuses, nothing saved', async () => {
    const res = await runRoute(ADMIN, 'PUT', '/api/profile', { timezone: 'UTC', siteName: 'New' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        "The brain's look (siteName) is changed by the brain owner or a user with the settings area. Ask one of them.",
    });
    expect(h.saved).toEqual([]);
  });

  it('with the settings area it saves', async () => {
    h.areas = ['settings'];
    const res = await runRoute(ADMIN, 'PUT', '/api/profile', { timezone: 'UTC', siteName: 'New' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.saved[0]?.siteName).toBe('New');
  });
});
