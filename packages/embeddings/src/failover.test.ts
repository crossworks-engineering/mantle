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
  },
}));

vi.mock('@mantle/db', () => ({
  db: {
    select: () => ({
      from: (t: unknown) => ({
        where: () => {
          const rows =
            t === h.embeddingConfigTable && h.state.configRow ? [h.state.configRow] : [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & { limit?: () => Promise<unknown[]> };
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

import { clearEmbeddingModelCache, embedBatch, isRouteDownError } from './index';

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
});

describe('isRouteDownError', () => {
  it('treats connectivity + 5xx as route-down (fail over)', () => {
    expect(isRouteDownError(new Error('fetch failed'))).toBe(true);
    expect(isRouteDownError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(true);
    expect(isRouteDownError(new Error('getaddrinfo ENOTFOUND host'))).toBe(true);
    expect(isRouteDownError(new Error('local embeddings failed: 503 Service Unavailable — x'))).toBe(
      true,
    );
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
});
