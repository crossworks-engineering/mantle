/**
 * GET /api/models and the explorer's key choice, without a database (task
 * 698e6faf). The vault is a fake: two Anthropic keys, neither labelled
 * 'default', one OpenAI key, and another owner's key. The providers are a
 * stubbed fetch: no paid API is called. The real SQL order of the fallback
 * is pinned in models-keys.db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';
const WORK = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const OPENAI = '44444444-4444-4444-8444-444444444444';
const THEIRS = '55555555-5555-4555-8555-555555555555';

const VAULT: Record<string, { owner: string; service: string; plaintext: string }> = {
  [WORK]: { owner: OWNER, service: 'anthropic', plaintext: 'sk-ant-work' },
  [TEAM]: { owner: OWNER, service: 'anthropic', plaintext: 'sk-ant-team' },
  [OPENAI]: { owner: OWNER, service: 'openai', plaintext: 'sk-openai' },
  [THEIRS]: { owner: 'someone-else', service: 'anthropic', plaintext: 'sk-theirs' },
};

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({ id: OWNER, actor: { id: OWNER } })),
}));

vi.mock('@mantle/api-keys', () => ({
  // The fallback: no 'default' label on file, so the most recent (WORK).
  findProviderKeyId: vi.fn(async (owner: string, service: string) => {
    const hit = Object.entries(VAULT).find(([, k]) => k.owner === owner && k.service === service);
    return hit?.[0] ?? null;
  }),
  getApiKeyById: vi.fn(async (id: string) => VAULT[id]?.plaintext ?? null),
  ownedKeyService: vi.fn(async (owner: string, id: string) =>
    VAULT[id]?.owner === owner ? VAULT[id]!.service : null,
  ),
}));

import { GET } from './route';
import { clearModelCache } from '@/lib/model-explorer';

type Body = { models: { id: string }[]; needsKey?: boolean; error?: string };

const refused = new Set<string>();
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  refused.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('x-api-key') ?? '';
      calls.push(key);
      if (refused.has(key)) {
        return new Response('{"error":"invalid x-api-key for org acct_SECRET"}', { status: 401 });
      }
      return Response.json({ data: [{ id: `model-for-${key}` }] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCache();
});

const get = (qs: string) => GET(new Request(`http://brain.test/api/models?${qs}`));

describe('GET /api/models with a picked key', () => {
  it('lists models with a key not labelled default', async () => {
    const res = await get(`provider=anthropic&keyId=${TEAM}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.needsKey).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual(['model-for-sk-ant-team']);
  });

  it('falls back to the provider key on file when none is picked (an older client)', async () => {
    const body = (await (await get('provider=anthropic')).json()) as Body;
    expect(body.models.map((m) => m.id)).toEqual(['model-for-sk-ant-work']);
  });

  it('still answers needsKey when the provider has no key at all', async () => {
    const body = (await (await get('provider=mistral')).json()) as Body;
    expect(body).toMatchObject({ models: [], needsKey: true });
    expect(calls).toEqual([]);
  });

  it('refuses a key of another service with a clear 400', async () => {
    const res = await get(`provider=anthropic&keyId=${OPENAI}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'That key is for openai, not anthropic.',
    );
    expect(calls).toEqual([]);
  });

  it("answers another owner's key exactly as a missing one", async () => {
    const theirs = await get(`provider=anthropic&keyId=${THEIRS}`);
    const missing = await get('provider=anthropic&keyId=66666666-6666-4666-8666-666666666666');
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
    expect((await get('provider=anthropic&keyId=nope')).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('caches one list per key of a provider', async () => {
    const a = (await (await get(`provider=anthropic&keyId=${WORK}`)).json()) as Body;
    const b = (await (await get(`provider=anthropic&keyId=${TEAM}`)).json()) as Body;
    expect(a.models[0]!.id).toBe('model-for-sk-ant-work');
    expect(b.models[0]!.id).toBe('model-for-sk-ant-team');
    await get(`provider=anthropic&keyId=${WORK}`);
    await get(`provider=anthropic&keyId=${TEAM}`);
    expect(calls).toEqual(['sk-ant-work', 'sk-ant-team']);
    // refresh=1 busts only that key's entry.
    await get(`provider=anthropic&keyId=${TEAM}&refresh=1`);
    expect(calls).toEqual(['sk-ant-work', 'sk-ant-team', 'sk-ant-team']);
  });

  it('says a refused key in a fixed sentence, never the provider body', async () => {
    refused.add('sk-ant-team');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = (await (await get(`provider=anthropic&keyId=${TEAM}`)).json()) as Body;
    errSpy.mockRestore();
    expect(body.models).toEqual([]);
    expect(body.error).toBe('The provider refused the API key. (anthropic, HTTP 401)');
    expect(JSON.stringify(body)).not.toMatch(/SECRET|acct_/);
    // A failed list is not cached: the next ask tries again.
    refused.clear();
    const again = (await (await get(`provider=anthropic&keyId=${TEAM}`)).json()) as Body;
    expect(again.models).toHaveLength(1);
  });
});
