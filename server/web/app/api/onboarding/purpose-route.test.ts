/**
 * POST /api/onboarding { action: 'purpose' } without a database. An over-long
 * purpose is REFUSED with a 400 and a message naming the limit; it is never
 * trimmed and saved. On 2026-09-28 a silent slice dropped 3,288 characters of
 * a pasted persona prompt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PURPOSE_MAX_CHARS } from '@mantle/client-types/purpose-limits';

const OWNER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ saved: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: OWNER, email: 'owner@example.invalid' })),
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

const post = async (purpose: string) => {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example.invalid/api/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'purpose', archetype: 'personal', purpose }),
    }),
  );
};

describe('onboarding purpose step', () => {
  it('saves a purpose at the limit verbatim (trimmed only)', async () => {
    const text = 'a'.repeat(PURPOSE_MAX_CHARS);
    const res = await post(`  ${text}  `);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.saved).toEqual([
      { purpose: text, purposeArchetype: 'personal', onboardingStep: 'personality' },
    ]);
  });

  it('refuses a purpose over the limit with a 400 and saves nothing', async () => {
    const res = await post(`You are Saskia.\n\n## Tone\n${'x'.repeat(3863)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('3,888');
    expect(body.error).toContain('600');
    expect(h.saved).toEqual([]);
  });

  it('still answers a blank purpose with ok:false (200), as before', async () => {
    const res = await post('   ');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: 'Describe what this brain is for.' });
    expect(h.saved).toEqual([]);
  });
});
