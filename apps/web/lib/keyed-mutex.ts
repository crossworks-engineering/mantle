/**
 * A per-key async mutex: `withKeyedLock(key, fn)` runs `fn` while no other
 * caller holds `key`, chaining contenders so they run strictly one at a time.
 *
 * Scope + limits: this serializes within ONE Node process. Mantle deploys
 * one web instance per brain (see lib/rate-limit.ts — the same single-instance
 * assumption backs the in-memory rate limiter), so per-owner critical sections
 * that must not interleave — filing a forum upload into `files/review/` while
 * another filing races the same folder/filename — are correctly serialized.
 * If Mantle ever runs multiple web replicas, swap the callers to a Postgres
 * advisory lock (the API here stays the same).
 */
const chains = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Everyone waits on the tail; failures don't break the chain.
  const run = prev.catch(() => {}).then(fn);
  // Track the tail so the next contender queues behind this run; clean the map
  // entry when this is the last one so it can't leak keys forever.
  chains.set(key, run);
  try {
    return await run;
  } finally {
    if (chains.get(key) === run) chains.delete(key);
  }
}
