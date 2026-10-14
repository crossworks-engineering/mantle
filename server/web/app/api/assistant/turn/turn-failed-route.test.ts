/**
 * POST /api/assistant/turn when the turn fails (A10 part 2 fix round 1, L6),
 * without a database: the login is stood in, and the turn's first step (the
 * chat agent's lookup) throws a text the caller must not read. An Admin user reads
 * that text in the 500 (it set the provider up); a member or a client hears
 * a fixed sentence, and the text stays in the server log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROVIDER_TEXT = 'upstream 429: rate limited on key sk-hidden';

const h = vi.hoisted(() => ({ kind: 'admin' as 'admin' | 'member' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chatLoginCaller: () => ({
    kind: h.kind,
    ownerId: 'owner-id',
    loginId: `${h.kind}-id`,
    source: 'cookie',
    user: { id: 'owner-id', email: '', actor: { id: `${h.kind}-id` } },
    displayName: null,
    email: `${h.kind}@example.invalid`,
  }),
}));
vi.mock('@/lib/assistant-chat', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveChatAgent: async () => {
    throw new Error(PROVIDER_TEXT);
  },
}));

const logged: unknown[][] = [];
beforeEach(() => {
  logged.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
});
afterEach(() => vi.restoreAllMocks());

async function turn(): Promise<Response> {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example.invalid/api/assistant/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    }),
  );
}

describe('POST /api/assistant/turn: a failed turn', () => {
  it('an Admin user reads the failure text (500)', async () => {
    h.kind = 'admin';
    const res = await turn();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: PROVIDER_TEXT });
  });

  it('a member hears a fixed sentence; the text is only in the log', async () => {
    h.kind = 'member';
    const res = await turn();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'The assistant could not answer. Try again.' });
    expect(JSON.stringify(body)).not.toContain('sk-hidden');
    expect(logged.flat().join(' ')).toContain(PROVIDER_TEXT);
  });
});
