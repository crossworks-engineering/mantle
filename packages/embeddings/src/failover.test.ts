import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Same-model failover coverage. The brain is vector-space-locked, so the
 * backup route must serve the SAME model on a different host. We drive that by
 * baseUrl: the mock adapter throws for the primary URL and succeeds for the
 * backup URL — which also proves the per-route `baseUrl` is threaded through.
 */

const h = vi.hoisted(() => ({
  embeddingConfigTable: { __t: 'embedding_config' },
  embeddingCacheTable: { __t: 'embedding_cache' },
  state: {
    configRow: null as Record<string, unknown> | null,
    primaryError: undefined as string | undefined,
    embedCalls: [] as Array<string | undefined>,
    /** Open alert subjects, as listOpenProviderAlerts sees them. */
    openAlerts: [] as string[],
  },
  recordProviderFailure: vi.fn(async () => null),
  resolveProviderAlert: vi.fn(async () => true),
}));

vi.mock('@mantle/db', () => ({
  // Infrastructure writes go through systemDb; the fake stands in for both.
  get systemDb(): unknown {
    return (this as { db: unknown }).db;
  },
  db: {
    select: () => ({
      from: (t: unknown) => ({
        where: () => {
          const rows = t === h.embeddingConfigTable && h.state.configRow ? [h.state.configRow] : [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit?: () => Promise<unknown[]>;
          };
          p.limit = () => Promise.resolve(rows);
          return p;
        },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  embeddingConfig: h.embeddingConfigTable,
  embeddingCache: h.embeddingCacheTable,
  // The provider-alert store (provider-outage.ts).
  recordProviderFailure: h.recordProviderFailure,
  resolveProviderAlert: h.resolveProviderAlert,
  listOpenProviderAlerts: async () => h.state.openAlerts.map((subject) => ({ subject })),
}));

vi.mock('@mantle/api-keys', () => ({
  getApiKey: async () => null,
  getApiKeyById: async () => null,
}));

vi.mock('@mantle/voice', () => ({
  getEmbeddingAdapter: (provider: string) => {
    if (provider !== 'local') return null;
    return {
      providerId: 'local',
      adapterName: 'local-embedding',
      acceptsInput: (i: unknown) =>
        typeof i === 'string' || (i as { type?: string })?.type === 'text',
      embed: async (req: { input: unknown[]; model: string; baseUrl?: string }) => {
        h.state.embedCalls.push(req.baseUrl);
        if (req.baseUrl === 'http://primary') {
          throw new Error(h.state.primaryError ?? 'fetch failed');
        }
        return { vectors: req.input.map(() => [1, 2, 3]), model: req.model };
      },
    };
  },
}));

import {
  clearEmbeddingModelCache,
  embedBatch,
  isRouteDownError,
  resetProviderOutageCache,
  resolveEmbeddingConfig,
} from './index';

function configRow(over: Record<string, unknown> = {}) {
  return {
    ownerId: 'owner-1',
    model: 'm',
    dimensions: 3,
    primaryProvider: 'local',
    primaryBaseUrl: 'http://primary',
    primaryApiKeyId: null,
    primaryLabel: 'Primary',
    backupEnabled: true,
    backupProvider: 'local',
    backupBaseUrl: 'http://backup',
    backupApiKeyId: null,
    backupLabel: 'Backup',
    lastFailoverAt: null,
    ...over,
  };
}

describe('embedding failover', () => {
  beforeEach(() => {
    h.state.configRow = null;
    h.state.primaryError = undefined;
    h.state.embedCalls = [];
    clearEmbeddingModelCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('fails over to the same-model backup when the primary route is down', async () => {
    h.state.configRow = configRow();
    const out = await embedBatch('owner-1', ['hi']);
    expect(out).toEqual([[1, 2, 3]]);
    // Primary tried first (threw), then backup — proving baseUrl is threaded.
    expect(h.state.embedCalls).toEqual(['http://primary', 'http://backup']);
  });

  it('does NOT fail over on a bad-input (4xx) error — it rethrows', async () => {
    h.state.configRow = configRow();
    h.state.primaryError = 'embeddings failed: 400 Bad Request — nope';
    await expect(embedBatch('owner-1', ['hi'])).rejects.toThrow(/400/);
    expect(h.state.embedCalls).toEqual(['http://primary']); // backup never tried
  });

  it('rethrows when the primary is down and no backup is configured', async () => {
    h.state.configRow = configRow({ backupEnabled: false });
    await expect(embedBatch('owner-1', ['hi'])).rejects.toThrow(/fetch failed/);
    expect(h.state.embedCalls).toEqual(['http://primary']);
  });

  it('fails over on an account error: no credits on the primary (2026-10-04)', async () => {
    h.state.configRow = configRow();
    h.state.primaryError =
      'OpenAI embeddings failed: 429 Too Many Requests — {"error":{"code":"insufficient_quota"}}';
    const out = await embedBatch('owner-1', ['hi']);
    expect(out).toEqual([[1, 2, 3]]);
    expect(h.state.embedCalls).toEqual(['http://primary', 'http://backup']);
  });
});

describe('embedding outcomes reach the provider-alert store', () => {
  beforeEach(() => {
    h.state.configRow = null;
    h.state.primaryError = undefined;
    h.state.embedCalls = [];
    h.state.openAlerts = [];
    h.recordProviderFailure.mockClear();
    h.resolveProviderAlert.mockClear();
    clearEmbeddingModelCache();
    resetProviderOutageCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('records a failure with the fixed reason, the provider and the model, never the body', async () => {
    h.state.configRow = configRow({ backupEnabled: false });
    h.state.primaryError =
      'OpenAI embeddings failed: 429 Too Many Requests — {"error":{"code":"insufficient_quota","org":"org-SECRET"}}';
    const err = await embedBatch('owner-1', ['hi']).catch((e: unknown) => e);
    expect((err as { providerSubject?: string }).providerSubject).toBe('embedding');
    expect(h.recordProviderFailure).toHaveBeenCalledTimes(1);
    const [owner, subject, failure] = h.recordProviderFailure.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(owner).toBe('owner-1');
    expect(subject).toBe('embedding');
    expect(failure).toMatchObject({
      code: 'quota',
      permanent: true,
      provider: 'local',
      model: 'm',
    });
    expect(JSON.stringify(failure)).not.toMatch(/SECRET/);
  });

  it('writes at most one failure per minute for a burst', async () => {
    h.state.configRow = configRow({ backupEnabled: false });
    for (let i = 0; i < 5; i++) await embedBatch('owner-1', [`x${i}`]).catch(() => {});
    expect(h.recordProviderFailure).toHaveBeenCalledTimes(1);
  });

  it('a bad input is not recorded', async () => {
    h.state.configRow = configRow({ backupEnabled: false });
    h.state.primaryError = 'embeddings failed: 400 Bad Request — input too long';
    await embedBatch('owner-1', ['hi']).catch(() => {});
    expect(h.recordProviderFailure).not.toHaveBeenCalled();
  });

  it('a call that works closes an open alert', async () => {
    h.state.configRow = configRow({ primaryBaseUrl: 'http://ok', backupEnabled: false });
    h.state.openAlerts = ['embedding'];
    await embedBatch('owner-1', ['fresh text']);
    await flush();
    await flush();
    expect(h.resolveProviderAlert).toHaveBeenCalledWith('owner-1', 'embedding');
  });

  it('a call that works with no open alert writes nothing', async () => {
    h.state.configRow = configRow({ primaryBaseUrl: 'http://ok', backupEnabled: false });
    await embedBatch('owner-1', ['fresh text']);
    await flush();
    await flush();
    expect(h.resolveProviderAlert).not.toHaveBeenCalled();
  });
});

describe('resolveEmbeddingConfig', () => {
  beforeEach(() => {
    h.state.configRow = null;
    clearEmbeddingModelCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('maps the config row to {model, dimensions, primary, backup}', async () => {
    h.state.configRow = configRow();
    const c = await resolveEmbeddingConfig('owner-1');
    expect(c.model).toBe('m');
    expect(c.dimensions).toBe(3);
    expect(c.primary).toEqual({
      provider: 'local',
      baseUrl: 'http://primary',
      apiKeyId: null,
      label: 'Primary',
    });
    expect(c.backup).toEqual({
      provider: 'local',
      baseUrl: 'http://backup',
      apiKeyId: null,
      label: 'Backup',
    });
  });

  it('returns backup=null when failover is disabled', async () => {
    h.state.configRow = configRow({ backupEnabled: false });
    const c = await resolveEmbeddingConfig('owner-1');
    expect(c.backup).toBeNull();
  });

  it('falls back to the local-768 default when there is no row', async () => {
    h.state.configRow = null;
    const c = await resolveEmbeddingConfig('owner-1');
    expect(c.dimensions).toBe(768);
    expect(c.primary.provider).toBe('local');
    expect(c.backup).toBeNull();
  });
});

describe('isRouteDownError', () => {
  it('treats connectivity + 5xx as route-down (fail over)', () => {
    expect(isRouteDownError(new Error('fetch failed'))).toBe(true);
    expect(isRouteDownError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(true);
    expect(isRouteDownError(new Error('getaddrinfo ENOTFOUND host'))).toBe(true);
    expect(
      isRouteDownError(new Error('local embeddings failed: 503 Service Unavailable — x')),
    ).toBe(true);
    expect(isRouteDownError(new TypeError('Failed to fetch'))).toBe(true);
    const ab = new Error('aborted');
    ab.name = 'AbortError';
    expect(isRouteDownError(ab)).toBe(true);
  });

  it('treats 4xx + unknown errors as NOT route-down (rethrow)', () => {
    expect(isRouteDownError(new Error('local embeddings failed: 400 Bad Request — x'))).toBe(false);
    expect(isRouteDownError(new Error('local embeddings failed: 404 Not Found — x'))).toBe(false);
    expect(isRouteDownError(new Error('some unrelated failure'))).toBe(false);
    expect(isRouteDownError('a string')).toBe(false);
    expect(isRouteDownError(null)).toBe(false);
  });

  it('reads a status the error carries in preference to one in its prose', () => {
    const carried = Object.assign(new Error('upstream said no'), { status: 503 });
    expect(isRouteDownError(carried)).toBe(true);
    const clientSide = Object.assign(new Error('upstream said no'), { status: 422 });
    expect(isRouteDownError(clientSide)).toBe(false);
  });

  it('does not read an unrelated three-digit number as a status', () => {
    // The trap in a loose /\b4\d\d\b/: any number in the message decides the
    // route's fate. Stranding the caller on a dead primary because the message
    // mentioned a dimension count is the expensive direction of this mistake.
    expect(isRouteDownError(new Error('embed failed: 500 — expected 400 dimensions'))).toBe(true);
    expect(isRouteDownError(new Error('vector length 768 does not match 512'))).toBe(false);
    expect(isRouteDownError(new Error('model gemma-embed returned 404 vectors, wanted 500'))).toBe(
      false,
    );
  });
});
