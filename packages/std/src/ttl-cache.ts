/**
 * The one in-process TTL cache, used instead of a hand-rolled Map of
 * `{ at, value }` and an age check: a value is fresh while its age is under
 * its TTL, a stale one is dropped when it is read, and a bound (when given)
 * evicts the least recently used entry.
 *
 * Per process only. No node builtins (this package is bundled for the
 * browser too).
 */
export type TtlCacheOptions = {
  /** How long a value stays fresh, in ms (a set may name its own). */
  ttlMs: number;
  /** The most entries kept; past it the least recently used goes. No bound
   *  when not given. */
  maxEntries?: number;
  /** The clock (tests). */
  now?: () => number;
};

type Entry<V> = { value: V; at: number; ttlMs: number };

export class TtlCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The fresh value of `key` (its age under its TTL), else undefined; a
   *  stale entry is dropped. A read makes the entry the most recently used. */
  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (!this.fresh(hit, this.now())) {
      this.map.delete(key);
      return undefined;
    }
    if (this.maxEntries !== Number.POSITIVE_INFINITY) {
      // Map iteration order is insertion order: re-insert to refresh recency.
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit.value;
  }

  /** The entry under `key` whatever its age, and whether it is fresh: a
   *  reader that serves the last value while a refresh runs (stale while
   *  revalidate). Drops nothing and leaves the recency as it is. */
  peek(key: K): { value: V; fresh: boolean } | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    return { value: hit.value, fresh: this.fresh(hit, this.now()) };
  }

  /** Keep `value` under `key` from now, for `ttlMs` (the cache's own when
   *  not given). */
  set(key: K, value: V, ttlMs: number = this.ttlMs): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: this.now(), ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Drop every stale entry (a cache read by key only, swept now and then). */
  prune(): void {
    const now = this.now();
    for (const [k, e] of this.map) if (!this.fresh(e, now)) this.map.delete(k);
  }

  /** The one freshness rule: the age is under the entry's TTL. */
  private fresh(e: Entry<V>, now: number): boolean {
    return now - e.at < e.ttlMs;
  }

  clear(): void {
    this.map.clear();
  }

  /** Entries held, stale ones not yet dropped included. */
  get size(): number {
    return this.map.size;
  }
}
