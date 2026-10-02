/**
 * The bundle text cache (apps audit P3): a content-addressed key loads once,
 * the least recently used entry goes first past the bound, and a failed or
 * oversized load is not kept.
 */
import { describe, expect, it, vi } from 'vitest';
import { BundleTextCache } from './bundle-text-cache';

describe('BundleTextCache', () => {
  it('loads a key once and serves it from memory after', async () => {
    const cache = new BundleTextCache(100);
    const load = vi.fn(async () => 'code');
    expect(await cache.get('k1', load)).toBe('code');
    expect(await cache.get('k1', load)).toBe('code');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('drops the least recently used entry past the bound', async () => {
    const cache = new BundleTextCache(10);
    await cache.get('a', async () => 'aaaa');
    await cache.get('b', async () => 'bbbb');
    await cache.get('a', async () => 'never'); // a is now the most recent
    await cache.get('c', async () => 'cccc'); // 12 chars: b goes
    expect(cache.size()).toEqual({ entries: 2, chars: 8 });
    expect(await cache.get('a', async () => 'never')).toBe('aaaa');
    const reload = vi.fn(async () => 'bbbb');
    await cache.get('b', reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps neither a failed load nor one larger than the bound', async () => {
    const cache = new BundleTextCache(5);
    await expect(
      cache.get('x', async () => {
        throw new Error('storage down');
      }),
    ).rejects.toThrow('storage down');
    expect(await cache.get('big', async () => 'too long')).toBe('too long');
    expect(cache.size()).toEqual({ entries: 0, chars: 0 });
  });
});
