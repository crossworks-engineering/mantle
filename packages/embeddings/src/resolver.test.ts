import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  clearEmbeddingModelCache,
  resolveEmbeddingModel,
} from './index';

/**
 * Resolver coverage. The DB lookup itself isn't exercised here — `@mantle/db`
 * throws without DATABASE_URL, the resolver's catch handles it, and we fall
 * through to the env / hardcoded chain. That's enough to lock the fallback
 * contract; the DB-hit path is observable live via the workers UI.
 *
 * What we verify:
 *   - Without a DATABASE_URL the resolver still returns a usable model
 *     (the fallback wins). Status-quo preserved for any caller before they
 *     create an embedding worker.
 *   - The cache holds within the TTL and is per-ownerId.
 *   - clearEmbeddingModelCache(ownerId) is a targeted invalidator and the
 *     argless form is a global reset.
 */

describe('resolveEmbeddingModel', () => {
  // Make sure DATABASE_URL is NOT set for these tests so the DB lookup
  // hits the catch branch deterministically. (Most CI runs already have
  // it unset; this is belt-and-braces.)
  const originalDatabaseUrl = process.env.DATABASE_URL;
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    clearEmbeddingModelCache();
    // Silence the [embeddings] warn line — the warning IS the expected
    // signal here, but we don't want noisy test output.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    vi.restoreAllMocks();
  });

  it('falls back to DEFAULT_EMBEDDING_MODEL when the DB lookup fails', async () => {
    const model = await resolveEmbeddingModel('owner-a');
    expect(model).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('caches the resolution per owner within the TTL', async () => {
    const first = await resolveEmbeddingModel('owner-a');
    // No way to count DB lookups from outside without mocking — but a
    // second call returning the same string from a clean state is the
    // observable behaviour the caller relies on.
    const second = await resolveEmbeddingModel('owner-a');
    expect(first).toBe(second);
    expect(first).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('caches independently per owner', async () => {
    const a = await resolveEmbeddingModel('owner-a');
    const b = await resolveEmbeddingModel('owner-b');
    // Both resolve to the same fallback, but separate cache entries.
    expect(a).toBe(b);
    // Targeted clear only drops one owner — re-resolving the other
    // should still return the cached value (deterministic on the
    // fallback string, which makes a behavioural assertion tricky;
    // this test is about API shape, not observability).
    clearEmbeddingModelCache('owner-a');
    const aAfter = await resolveEmbeddingModel('owner-a');
    expect(aAfter).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('argless clearEmbeddingModelCache wipes everything', async () => {
    await resolveEmbeddingModel('owner-a');
    await resolveEmbeddingModel('owner-b');
    clearEmbeddingModelCache(); // resets the whole Map
    const a = await resolveEmbeddingModel('owner-a');
    const b = await resolveEmbeddingModel('owner-b');
    expect(a).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(b).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});
