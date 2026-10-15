/**
 * The agent form's model list with a key not labelled 'default' (task
 * 698e6faf), on a real migrated Postgres. A key added on /settings/keys keeps
 * the label typed there; the catalog and the chat fallbacks looked up the
 * 'default' label only, so a newly added Anthropic key listed no models and
 * the agent could not be switched to it. Now GET /api/models takes the
 * picked key (`keyId`, checked: the owner's AND this provider's), falls back
 * to the provider's own key on file (resolveProviderKey: 'default' first,
 * else the oldest), caches per key, and says a refused key in a fixed
 * sentence. The providers are a stubbed fetch: no paid API is called. Only
 * the owner check is stubbed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run models-keys.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({
    id: h.owner,
    actor: { id: h.owner, displayName: 'Admin' },
  })),
}));

/** A fake provider: lists one model named after the key it was called with;
 *  `refused` keys answer 401 with a body that must never reach the caller. */
function fakeProviders(refused: Set<string>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    // The public OpenRouter catalog the explorer reads for direct models'
    // context windows: not a provider key call, not counted.
    if (String(input).includes('openrouter.ai')) return Response.json({ data: [] });
    const headers = new Headers(init?.headers);
    const key = headers.get('x-api-key') ?? headers.get('authorization') ?? '';
    calls.push(key);
    if (refused.has(key)) {
      return new Response('{"error":"invalid x-api-key acct_SECRET-ORG"}', { status: 401 });
    }
    const model = `model-for-${key.replace(/^Bearer /, '')}`;
    void input;
    return Response.json({ data: [{ id: model, display_name: model }] });
  });
  return { fn, calls };
}

describe.skipIf(!URL)('the model list with a key not labelled default', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let keys: typeof import('@mantle/api-keys');
  let explorer: typeof import('@/lib/model-explorer');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const other = randomUUID();
  const tag = `models-keys-${owner.slice(0, 8)}`;
  let workKey = '';
  let teamKey = '';
  let openaiKey = '';
  let otherOwnersKey = '';
  let prevMasterKey: string | undefined;

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const get = async (qs: string) => {
    const { GET } = await import('./route');
    return GET(new Request(`http://brain.test/api/models?${qs}`));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    prevMasterKey = process.env.MANTLE_MASTER_KEY;
    // A 32-byte key for the vault, the caller's when it has one: under
    // MANTLE_DB_RUNTIME_ROLE the system pool's password is derived from it,
    // so another key here would lock this file's pool out (arch A9).
    process.env.MANTLE_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    m = await import('@mantle/db');
    keys = await import('@mantle/api-keys');
    explorer = await import('@/lib/model-explorer');
    sqlTag = (await import('drizzle-orm')).sql;
    h.owner = owner;
    for (const id of [owner, other]) {
      await exec(sqlTag`
        insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`${tag}-${id.slice(0, 4)}@example.invalid`}, 'x', 'admin')`);
    }
    // Two Anthropic keys, neither labelled 'default': what the keys page
    // saves when the label field is changed.
    workKey = (await keys.setApiKey(owner, 'anthropic', 'work', 'sk-ant-work')).id;
    teamKey = (await keys.setApiKey(owner, 'anthropic', 'team', 'sk-ant-team')).id;
    openaiKey = (await keys.setApiKey(owner, 'openai', 'mine', 'sk-openai-mine')).id;
    otherOwnersKey = (await keys.setApiKey(other, 'anthropic', 'default', 'sk-ant-other')).id;
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
    explorer.clearModelCache();
  });

  afterAll(async () => {
    if (!m) return;
    await exec(sqlTag`delete from api_keys where user_id in (${owner}, ${other})`);
    await exec(sqlTag`delete from auth.users where id in (${owner}, ${other})`);
    await m.closeDb();
    if (prevMasterKey === undefined) delete process.env.MANTLE_MASTER_KEY;
    else process.env.MANTLE_MASTER_KEY = prevMasterKey;
  }, 60_000);

  it('lists models with the picked key though its label is not default', async () => {
    const p = fakeProviders(new Set());
    vi.stubGlobal('fetch', p.fn);
    const res = await get(`provider=anthropic&keyId=${workKey}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { id: string }[]; needsKey?: boolean };
    expect(body.needsKey).toBeUndefined();
    expect(body.models.map((x) => x.id)).toEqual(['model-for-sk-ant-work']);
  });

  it('with no key picked, uses a key of the provider on file (was needsKey)', async () => {
    const p = fakeProviders(new Set());
    vi.stubGlobal('fetch', p.fn);
    const res = await get('provider=anthropic');
    const body = (await res.json()) as { models: { id: string }[]; needsKey?: boolean };
    expect(body.needsKey).toBeUndefined();
    expect(body.models).toHaveLength(1);
  });

  it("refuses a key of another service, and another owner's key reads as missing", async () => {
    vi.stubGlobal('fetch', fakeProviders(new Set()).fn);
    const wrong = await get(`provider=anthropic&keyId=${openaiKey}`);
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/for openai, not anthropic/);
    const theirs = await get(`provider=anthropic&keyId=${otherOwnersKey}`);
    expect(theirs.status).toBe(404);
    const missing = await get(`provider=anthropic&keyId=${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
    expect((await get('provider=anthropic&keyId=not-a-uuid')).status).toBe(400);
  });

  it('keeps one cached list per key of a provider', async () => {
    const p = fakeProviders(new Set());
    vi.stubGlobal('fetch', p.fn);
    const a = (await (await get(`provider=anthropic&keyId=${workKey}`)).json()) as {
      models: { id: string }[];
    };
    const b = (await (await get(`provider=anthropic&keyId=${teamKey}`)).json()) as {
      models: { id: string }[];
    };
    expect(a.models[0]!.id).toBe('model-for-sk-ant-work');
    expect(b.models[0]!.id).toBe('model-for-sk-ant-team');
    // Both answered from cache now: no third provider call.
    await get(`provider=anthropic&keyId=${workKey}`);
    await get(`provider=anthropic&keyId=${teamKey}`);
    expect(p.calls).toHaveLength(2);
  });

  it('a public catalog keeps one entry whatever key is picked', () => {
    expect(explorer.modelCacheKey('openrouter', null)).toBe('openrouter');
    expect(explorer.modelCacheKey('anthropic', workKey)).toBe(`anthropic:${workKey}`);
  });

  it('says a refused key in a fixed sentence, never the provider body', async () => {
    vi.stubGlobal('fetch', fakeProviders(new Set(['sk-ant-team'])).fn);
    const res = await get(`provider=anthropic&keyId=${teamKey}`);
    const body = (await res.json()) as { models: unknown[]; error?: string };
    expect(body.models).toEqual([]);
    expect(body.error).toBe('The provider refused the API key. (anthropic, HTTP 401)');
    expect(JSON.stringify(body)).not.toMatch(/SECRET|acct_/);
  });

  it("resolveProviderKey: the pinned key, else 'default', else the oldest", async () => {
    // Fix the ages: the work key is the older one.
    await exec(
      sqlTag`update api_keys set created_at = now() - interval '2 hours' where id = ${workKey}`,
    );
    await exec(
      sqlTag`update api_keys set created_at = now() - interval '1 hour' where id = ${teamKey}`,
    );
    expect(await keys.resolveProviderKey(owner, 'anthropic', teamKey)).toBe('sk-ant-team');
    // A pinned id that no longer opens falls back to the service's own key.
    expect(await keys.resolveProviderKey(owner, 'anthropic', randomUUID())).toBe('sk-ant-work');
    expect(await keys.resolveProviderKey(owner, 'mistral')).toBeNull();
    // The oldest wins among non-default keys, and reading a key (which bumps
    // its last_used) never moves the pick: a pinned run used to flip it.
    expect(await keys.findProviderKeyId(owner, 'anthropic')).toBe(workKey);
    expect(await keys.getApiKeyById(teamKey)).toBe('sk-ant-team');
    await exec(
      sqlTag`update api_keys set last_used = now() + interval '1 hour' where id = ${teamKey}`,
    );
    expect(await keys.findProviderKeyId(owner, 'anthropic')).toBe(workKey);
    expect((await keys.findProviderKeyIds(owner)).get('anthropic')).toBe(workKey);
    // A 'default' key wins over an older one.
    const def = (await keys.setApiKey(owner, 'anthropic', 'default', 'sk-ant-default')).id;
    expect(await keys.findProviderKeyId(owner, 'anthropic')).toBe(def);
    expect(Object.fromEntries(await keys.findProviderKeyIds(owner))).toEqual({
      anthropic: def,
      openai: openaiKey,
    });
    await keys.deleteApiKey(owner, def);
  });

  it('a chat route with a key not labelled default uses it (pinned or not)', async () => {
    const { resolveChatKey } = await import('@mantle/runtime/agent');
    const pinned = await resolveChatKey(owner, {
      provider: 'anthropic',
      apiKeyId: workKey,
      configuredBy: null,
    });
    expect(pinned).toEqual({ ok: true, apiKey: 'sk-ant-work' });
    // A backup route with no pinned key: before, the 'default' lookup found
    // nothing and the route missed with no_api_key_id.
    const unpinned = await resolveChatKey(owner, {
      provider: 'openai',
      apiKeyId: null,
      configuredBy: null,
    });
    expect(unpinned).toEqual({ ok: true, apiKey: 'sk-openai-mine' });
  });
});
