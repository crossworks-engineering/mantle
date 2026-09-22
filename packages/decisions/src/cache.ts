/**
 * A small in-process decision cache. Key = (use, model, state, questions);
 * the same question over the same state gets the same answer without a
 * second call. Passage scoring hits this often inside one session (the same
 * question re-asked, the same chunk in several searches). Per-process only:
 * a durable table is a later step, once a shadow week says the hit rate is
 * worth a migration.
 */
import { createHash } from 'node:crypto';

export type CacheEntry<T> = { value: T; at: number };

export class DecisionCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  constructor(
    private readonly maxEntries = 500,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static key(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: Map iteration order is insertion order, so re-insert.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
