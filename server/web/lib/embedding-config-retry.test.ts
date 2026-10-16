/**
 * The "Try again" nudge, without a database (A10 lows fix round 1, M2; cost
 * safety). The provider_recover NOTIFY can make the agent re-drive a
 * dead-letter backlog (real model calls) even with no alert open, so a key
 * save sends it only for a model provider's key and only when an alert is
 * open; the Admin button keeps sending it always (an owner's explicit ask).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  probeNow: vi.fn(async (_owner: string) => 0),
  executeWrite: vi.fn(async (_q: unknown) => undefined),
  logError: vi.fn(),
}));

vi.mock('@mantle/db', () => ({
  db: {},
  embeddingConfig: {},
  executeWrite: h.executeWrite,
  requestProviderProbeNow: h.probeNow,
}));
vi.mock('@mantle/embeddings', () => ({
  clearEmbeddingModelCache: vi.fn(),
  EMBEDDING_DIMS: 768,
}));
vi.mock('@mantle/tracing', () => ({ log: () => ({ error: h.logError }) }));

beforeEach(() => {
  h.probeNow.mockReset();
  h.executeWrite.mockReset();
  h.logError.mockReset();
});

describe('retryProvidersAfterKeyChange (a key save)', () => {
  it('sends no NOTIFY when no alert is open', async () => {
    const { retryProvidersAfterKeyChange } = await import('./embedding-config');
    h.probeNow.mockResolvedValueOnce(0);
    await retryProvidersAfterKeyChange(OWNER, 'openai');
    expect(h.probeNow).toHaveBeenCalledWith(OWNER);
    expect(h.executeWrite).not.toHaveBeenCalled();
  });

  it('sends the NOTIFY once when an alert is open', async () => {
    const { retryProvidersAfterKeyChange } = await import('./embedding-config');
    h.probeNow.mockResolvedValueOnce(2);
    await retryProvidersAfterKeyChange(OWNER, 'anthropic');
    expect(h.executeWrite).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a key that is no model provider', async () => {
    const { retryProvidersAfterKeyChange } = await import('./embedding-config');
    h.probeNow.mockResolvedValue(3);
    for (const service of ['telegram', 'firecrawl', 'mapbox', 'mcp-github', 'my-secret']) {
      await retryProvidersAfterKeyChange(OWNER, service);
    }
    expect(h.probeNow).not.toHaveBeenCalled();
    expect(h.executeWrite).not.toHaveBeenCalled();
  });

  it('never throws: a failed read is logged', async () => {
    const { retryProvidersAfterKeyChange } = await import('./embedding-config');
    h.probeNow.mockRejectedValueOnce(new Error('db down'));
    await expect(retryProvidersAfterKeyChange(OWNER, 'openai')).resolves.toBeUndefined();
    expect(h.executeWrite).not.toHaveBeenCalled();
    expect(h.logError).toHaveBeenCalledTimes(1);
  });
});

describe('retryProvidersNow (the Admin button)', () => {
  it('sends the NOTIFY even with no alert open, as before', async () => {
    const { retryProvidersNow } = await import('./embedding-config');
    h.probeNow.mockResolvedValueOnce(0);
    expect(await retryProvidersNow(OWNER)).toBe(0);
    expect(h.executeWrite).toHaveBeenCalledTimes(1);
  });
});
