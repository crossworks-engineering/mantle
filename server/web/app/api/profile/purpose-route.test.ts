/**
 * PUT /api/profile without a database: Settings → Profile saves the brain's
 * purpose under the same rule as onboarding. Over the limit is a 400 that
 * names it; the old silent `.slice(0, 600)` is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PURPOSE_MAX_CHARS } from '@mantle/client-types/purpose-limits';

const OWNER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ saved: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: OWNER,
    email: 'owner@example.invalid',
    actor: { id: OWNER },
  })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  savePreferencesFor: vi.fn(async (_id: string, p: Record<string, unknown>) => {
    h.saved.push(p);
    return {};
  }),
}));

beforeEach(() => {
  h.saved = [];
});

const put = async (purpose: string) => {
  const { PUT } = await import('./route');
  return PUT(
    new Request('https://brain.example.invalid/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'UTC', purpose }),
    }),
  );
};

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
});
