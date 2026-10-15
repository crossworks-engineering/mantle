import { describe, expect, it } from 'vitest';
import { TtlCache } from './ttl-cache';

describe('TtlCache (A10 #15)', () => {
  it('is fresh while the age is under the TTL, and drops a stale entry on read', () => {
    let now = 1_000;
    const c = new TtlCache<string, number>({ ttlMs: 100, now: () => now });
    c.set('a', 1);
    now += 99;
    expect(c.get('a')).toBe(1);
    now += 1;
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('takes a TTL per entry', () => {
    let now = 0;
    const c = new TtlCache<string, string>({ ttlMs: 100, now: () => now });
    c.set('short', 's', 10);
    c.set('long', 'l');
    now = 50;
    expect(c.get('short')).toBeUndefined();
    expect(c.get('long')).toBe('l');
  });

  it('evicts the least recently used entry past its bound', () => {
    const c = new TtlCache<string, number>({ ttlMs: 1_000, maxEntries: 2, now: () => 0 });
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('keeps every entry with no bound, prunes the stale ones', () => {
    let now = 0;
    const c = new TtlCache<number, number>({ ttlMs: 10, now: () => now });
    for (let i = 0; i < 1_000; i++) c.set(i, i);
    expect(c.size).toBe(1_000);
    now = 5;
    c.set(-1, -1);
    now = 12;
    c.prune();
    expect(c.size).toBe(1);
    expect(c.get(-1)).toBe(-1);
  });
});
