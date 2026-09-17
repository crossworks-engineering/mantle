import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Chat primary→backup failover. The backup may be a different provider/model
 * (no vector-space lock, unlike embeddings). We partial-mock getChatAdapter to
 * script primary vs backup behaviour by provider id (keeping the real
 * classifyChatError so the 429/5xx-vs-4xx decision is exercised for real).
 */

const h = vi.hoisted(() => ({
  primaryChat: (() => ({ text: 'primary-reply', model: 'p-model' })) as (opts: unknown) => unknown,
  primaryCalls: 0,
  backupCalls: 0,
  // Last opts each route received — lets a test assert per-route baseUrl/
  // viaTailnet actually reach adapter.chat (migration 0063).
  lastPrimaryOpts: null as Record<string, unknown> | null,
  lastBackupOpts: null as Record<string, unknown> | null,
  // Controllable api-key lookups for the resolveChatKey tests. Default to a
  // present key; individual tests set these to null to exercise the miss paths.
  apiKeyByIdReturn: 'k' as string | null,
  apiKeyByServiceReturn: 'k' as string | null,
}));

vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/voice')>();
  return {
    ...actual,
    getChatAdapter: (provider: string) => ({
      providerId: provider,
      adapterName: `${provider}-chat`,
      chat: async (opts: { model: string }) => {
        if (provider === 'backup') {
          h.backupCalls++;
          h.lastBackupOpts = opts as Record<string, unknown>;
          return { text: 'backup-reply', model: opts.model };
        }
        h.primaryCalls++;
        h.lastPrimaryOpts = opts as Record<string, unknown>;
        return h.primaryChat(opts);
      },
    }),
  };
});

vi.mock('@mantle/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/api-keys')>();
  return {
    ...actual,
    getApiKey: async () => h.apiKeyByServiceReturn,
    getApiKeyById: async () => h.apiKeyByIdReturn,
  };
});

import {
  chatWithFailover,
  isChatFailover,
  resolveChatKey,
  resolveChatRoutes,
} from './chat-failover';
import type { ChatRoutes } from './chat-failover';

const ROUTES: ChatRoutes = {
  primary: {
    provider: 'primary',
    model: 'p-model',
    apiKeyId: null,
    baseUrl: null,
    viaTailnet: false,
  },
  backup: {
    provider: 'backup',
    model: 'b-model',
    apiKeyId: null,
    baseUrl: null,
    viaTailnet: false,
  },
};
const OPTS = { messages: [{ role: 'user' as const, content: 'hi' }] };
const down = () => {
  throw Object.assign(new Error('service unavailable'), { status: 503 });
};
const badInput = () => {
  throw Object.assign(new Error('context length exceeded'), { status: 400 });
};

describe('chatWithFailover', () => {
  beforeEach(() => {
    h.primaryCalls = 0;
    h.backupCalls = 0;
    h.lastPrimaryOpts = null;
    h.lastBackupOpts = null;
    h.primaryChat = () => ({ text: 'primary-reply', model: 'p-model' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('answers on the primary when it succeeds (no failover)', async () => {
    const r = await chatWithFailover('o', ROUTES, OPTS);
    expect(r.failedOver).toBe(false);
    expect(r.usedProvider).toBe('primary');
    expect(r.result.text).toBe('primary-reply');
    expect(h.backupCalls).toBe(0);
  });

  it('fails over to the (different-model) backup on a route-down / 5xx error', async () => {
    h.primaryChat = down;
    const r = await chatWithFailover('o', ROUTES, OPTS);
    expect(r.failedOver).toBe(true);
    expect(r.usedProvider).toBe('backup');
    expect(r.result.text).toBe('backup-reply');
    expect(r.result.model).toBe('b-model');
    expect(h.primaryCalls).toBe(1);
    expect(h.backupCalls).toBe(1);
  });

  it('does NOT fail over on a 4xx bad-input error — it rethrows', async () => {
    h.primaryChat = badInput;
    await expect(chatWithFailover('o', ROUTES, OPTS)).rejects.toThrow(/context length/);
    expect(h.backupCalls).toBe(0);
  });

  it('rethrows a route-down error when no backup is configured', async () => {
    h.primaryChat = down;
    await expect(
      chatWithFailover('o', { primary: ROUTES.primary, backup: null }, OPTS),
    ).rejects.toThrow(/service unavailable/);
    expect(h.backupCalls).toBe(0);
  });

  it('passes the primary route baseUrl + viaTailnet into adapter.chat (migration 0063)', async () => {
    const routes: ChatRoutes = {
      primary: {
        provider: 'primary',
        model: 'p-model',
        apiKeyId: null,
        baseUrl: 'http://gpu-box:11434/v1',
        viaTailnet: true,
      },
      backup: null,
    };
    await chatWithFailover('o', routes, OPTS);
    expect(h.lastPrimaryOpts?.baseUrl).toBe('http://gpu-box:11434/v1');
    expect(h.lastPrimaryOpts?.viaTailnet).toBe(true);
  });

  it('fails over to a backup carrying its OWN baseUrl/viaTailnet (no inheritance)', async () => {
    // Local-via-tailnet primary goes down → cloud-direct backup answers. The
    // backup call must NOT inherit the primary's baseUrl/viaTailnet — they're
    // only spread when truthy, so a plain backup carries neither.
    h.primaryChat = down;
    const routes: ChatRoutes = {
      primary: {
        provider: 'primary',
        model: 'p-model',
        apiKeyId: null,
        baseUrl: 'http://primary-box:11434/v1',
        viaTailnet: true,
      },
      backup: {
        provider: 'backup',
        model: 'b-model',
        apiKeyId: null,
        baseUrl: null,
        viaTailnet: false,
      },
    };
    const r = await chatWithFailover('o', routes, OPTS);
    expect(r.failedOver).toBe(true);
    expect(h.lastBackupOpts?.baseUrl).toBeUndefined();
    expect(h.lastBackupOpts?.viaTailnet).toBeUndefined();
  });
});

describe('resolveChatRoutes', () => {
  const base = {
    provider: 'anthropic',
    model: 'claude',
    apiKeyId: 'k1',
    baseUrl: 'http://gpu-box:11434/v1',
    viaTailnet: true,
    backupProvider: 'openrouter',
    backupModel: 'gpt',
    backupApiKeyId: 'k2',
    backupEnabled: true,
    backupBaseUrl: null,
    backupViaTailnet: false,
  };

  it('maps primary + enabled backup (incl. per-route baseUrl/viaTailnet)', () => {
    const r = resolveChatRoutes(base);
    expect(r.primary).toEqual({
      provider: 'anthropic',
      model: 'claude',
      apiKeyId: 'k1',
      baseUrl: 'http://gpu-box:11434/v1',
      viaTailnet: true,
    });
    expect(r.backup).toEqual({
      provider: 'openrouter',
      model: 'gpt',
      apiKeyId: 'k2',
      baseUrl: null,
      viaTailnet: false,
    });
  });

  it('returns backup=null when disabled or incomplete', () => {
    expect(resolveChatRoutes({ ...base, backupEnabled: false }).backup).toBeNull();
    expect(resolveChatRoutes({ ...base, backupModel: null }).backup).toBeNull();
  });
});

describe('isChatFailover', () => {
  it('fails over on 429 / 5xx / network, not on 4xx', () => {
    expect(isChatFailover(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isChatFailover(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(isChatFailover(new TypeError('fetch failed'))).toBe(true);
    expect(isChatFailover(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isChatFailover(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
  });
});

describe('resolveChatKey — the single source of truth for chat credentials', () => {
  beforeEach(() => {
    h.apiKeyByIdReturn = 'k';
    h.apiKeyByServiceReturn = 'k';
  });

  it('returns the local-keyless sentinel for provider=local with no key', async () => {
    h.apiKeyByIdReturn = null;
    h.apiKeyByServiceReturn = null;
    const r = await resolveChatKey('o', { provider: 'local', apiKeyId: null });
    expect(r).toEqual({ ok: true, apiKey: 'local' });
  });

  it('honours a pinned key even for local (e.g. a token-guarded proxy)', async () => {
    h.apiKeyByIdReturn = 'pinned';
    const r = await resolveChatKey('o', { provider: 'local', apiKeyId: 'key-id' });
    expect(r).toEqual({ ok: true, apiKey: 'pinned' });
  });

  it('returns the resolved key for a cloud provider that has one', async () => {
    const r = await resolveChatKey('o', { provider: 'anthropic', apiKeyId: 'key-id' });
    expect(r).toEqual({ ok: true, apiKey: 'k' });
  });

  it('misses with no_api_key_id when a cloud provider has NO key configured', async () => {
    h.apiKeyByIdReturn = null;
    h.apiKeyByServiceReturn = null;
    const r = await resolveChatKey('o', { provider: 'openrouter', apiKeyId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disposition).toBe('no_api_key_id');
  });

  it('misses with api_key_not_decryptable when a pinned cloud key is gone', async () => {
    // apiKeyId is set, but neither the pinned lookup nor the service key resolves.
    h.apiKeyByIdReturn = null;
    h.apiKeyByServiceReturn = null;
    const r = await resolveChatKey('o', { provider: 'anthropic', apiKeyId: 'deleted-id' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disposition).toBe('api_key_not_decryptable');
  });
});
