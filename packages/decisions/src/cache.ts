/**
 * A small in-process decision cache. Key = (use, model, state, questions);
 * the same question over the same state gets the same answer without a
 * second call. Passage scoring hits this often inside one session (the same
 * question re-asked, the same chunk in several searches). Per-process only:
 * a durable table is a later step, once a shadow week says the hit rate is
 * worth a migration.
 *
 * The one TTL cache of @mantle/std (TtlCache), bounded and least
 * recently used, with the key this package hashes (node:crypto stays here:
 * std is bundled for the browser too).
 */
import { createHash } from 'node:crypto';
import { TtlCache } from '@mantle/std';

export class DecisionCache<T> extends TtlCache<string, T> {
  constructor(maxEntries = 500, ttlMs = 10 * 60_000, now: () => number = () => Date.now()) {
    super({ ttlMs, maxEntries, now });
  }

  static key(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }
}
