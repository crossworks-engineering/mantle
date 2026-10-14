/**
 * POST /api/assistant/transcribe when the speech provider fails (A10 part 2
 * fix round 1, L6), without a database: the login, the worker, its key and
 * the adapter are stood in. An Admin user (who set the provider up) reads
 * the provider's text in the 422; a member or a client hears a fixed
 * sentence, and the provider's text stays in the server log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROVIDER_TEXT = 'provider says: quota exceeded for key sk-hidden';

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
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/workspace-turn', () => ({ claimMemberChatWork: async () => null }));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  asSystem: (fn: () => unknown) => fn(),
  getDefaultWorker: async () => ({
    slug: 'stt',
    provider: 'openai',
    model: 'whisper-1',
    apiKeyId: 'key-id',
    params: {},
  }),
}));
vi.mock('@mantle/api-keys', () => ({ getApiKeyById: async () => 'sk-hidden' }));
vi.mock('@mantle/voice', () => ({
  getSttAdapter: () => ({
    adapterName: 'stand-in',
    transcribe: async () => {
      throw new Error(PROVIDER_TEXT);
    },
  }),
}));

const logged: unknown[][] = [];
beforeEach(() => {
  logged.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
});
afterEach(() => vi.restoreAllMocks());

async function transcribe(): Promise<Response> {
  const { POST } = await import('./route');
  const form = new FormData();
  form.set('audio', new Blob([new Uint8Array(100)], { type: 'audio/webm' }), 'clip.webm');
  return POST(
    new Request('https://brain.example.invalid/api/assistant/transcribe', {
      method: 'POST',
      body: form,
    }),
  );
}

describe('POST /api/assistant/transcribe: a failed provider call', () => {
  it('an Admin user reads the provider text (422)', async () => {
    h.kind = 'admin';
    const res = await transcribe();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: PROVIDER_TEXT });
  });

  it('a member hears a fixed sentence; the provider text is only in the log', async () => {
    h.kind = 'member';
    const res = await transcribe();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: 'The voice service failed. Try again.' });
    expect(JSON.stringify(body)).not.toContain('sk-hidden');
    expect(logged.flat().join(' ')).toContain(PROVIDER_TEXT);
  });
});
