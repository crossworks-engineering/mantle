import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The embedding cache is an optimisation, and an optimisation must never fail
 * the read it exists to accelerate.
 *
 * On a read-only brain the `embedding_cache` INSERT is refused, and it used to
 * sit in the throwing path — so the refusal took the whole embed down. The
 * search route then caught that and degraded to full-text, which meant semantic
 * search answered keyword lookups with plausible hits and natural-language
 * questions with nothing at all: HTTP 200, no visible error. Silent degradation
 * rather than a 500, which is precisely why a route sweep looking for failures
 * walked past it.
 *
 * These tests pin the two halves of the contract — refusal is survivable, any
 * other write failure is still loud — because the difference between them is
 * the difference between a resilient read and a hidden bug.
 */

const h = vi.hoisted(() => ({
  embeddingConfigTable: { __t: 'embedding_config' },
  embeddingCacheTable: { __t: 'embedding_cache' },
  state: {
    /** Error the cache INSERT should throw, or undefined to succeed. */
    insertError: undefined as unknown,
    insertAttempts: 0,
  },
}));

vi.mock('@mantle/db', async (importOriginal) => {
  // The real predicate, not a copy — a duplicated code list here could drift
  // from the one production uses and the test would still pass. Importing the
  // real module is safe: `db` is a lazy Proxy that only connects on property
  // access, and this factory replaces it before anything touches it.
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    isWriteRefused: actual.isWriteRefused,
    db: {
      select: () => ({
        from: () => {
          const rows: unknown[] = [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit?: () => Promise<unknown[]>;
          };
          p.limit = () => Promise.resolve(rows);
          return { where: () => p };
        },
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            h.state.insertAttempts++;
            if (h.state.insertError) throw h.state.insertError;
          },
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    },
    embeddingConfig: h.embeddingConfigTable,
    embeddingCache: h.embeddingCacheTable,
  };
});

vi.mock('@mantle/api-keys', () => ({
  getApiKey: async () => null,
  getApiKeyById: async () => null,
}));

vi.mock('@mantle/voice', () => ({
  getEmbeddingAdapter: (provider: string) =>
    provider !== 'local'
      ? null
      : {
          providerId: 'local',
          adapterName: 'local-embedding',
          acceptsInput: (i: unknown) =>
            typeof i === 'string' || (i as { type?: string })?.type === 'text',
          // 768 dims — the config's locked dimension. A short vector trips
          // the dim guard before the cache write is ever reached.
          embed: async (req: { input: unknown[]; model: string }) => ({
            vectors: req.input.map(() => VEC),
            model: req.model,
          }),
        },
}));

/**
 * A FRESH module per test. The "warn once" flag is module-level by design, so a
 * shared import would let the first test consume the single warning and make
 * every later assertion depend on execution order.
 */
async function freshEmbeddings() {
  vi.resetModules();
  return (await import('./index')) as typeof import('./index');
}

const VEC = Array.from({ length: 768 }, () => 0.1);
const OWNER = '00000000-0000-0000-0000-000000000001';
/** Postgres: the role has no INSERT right on the table. */
const REFUSED = Object.assign(new Error('permission denied for table embedding_cache'), {
  code: '42501',
});

beforeEach(() => {
  h.state.insertError = undefined;
  h.state.insertAttempts = 0;
  vi.restoreAllMocks();
});

describe('embedding_cache write on a read-only brain', () => {
  it('still returns the vectors when the cache INSERT is refused', async () => {
    h.state.insertError = REFUSED;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The vectors are computed before the cache write, so nothing about the
    // result should change — only the caching of it is lost.
    const { embedBatch } = await freshEmbeddings();
    const out = await embedBatch(OWNER, ['issued for tender']);
    expect(out).toEqual([VEC]);
    expect(h.state.insertAttempts).toBe(1);
  });

  it('warns ONCE per process, not once per query', async () => {
    h.state.insertError = REFUSED;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { embedBatch } = await freshEmbeddings();
    for (let i = 0; i < 4; i++) await embedBatch(OWNER, [`novel query ${i}`]);

    // Every search embeds a novel string, so per-occurrence logging would bury
    // a public demo's log under identical lines.
    expect(h.state.insertAttempts).toBe(4);
    const cacheWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('embedding_cache'));
    expect(cacheWarnings).toHaveLength(1);
  });

  it('still THROWS on a write failure that is not a refusal', async () => {
    // The guard must stay narrow. Swallowing everything here would trade a
    // visible failure for a silently empty cache — the bug in reverse.
    h.state.insertError = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const { embedBatch } = await freshEmbeddings();
    await expect(embedBatch(OWNER, ['x'])).rejects.toThrow(/deadlock/);
  });

  it('unwraps a refusal reported through a wrapper cause', async () => {
    // Drizzle wraps the driver error, so the code is rarely on the top object.
    h.state.insertError = new Error('Failed query', { cause: { code: '42501' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { embedBatch } = await freshEmbeddings();
    await expect(embedBatch(OWNER, ['y'])).resolves.toEqual([VEC]);
  });
});
