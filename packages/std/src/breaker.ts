/**
 * THE in-process circuit breaker (@mantle/decisions guards the decider
 * endpoint with it). A DEAD endpoint fails fast; a SLOW
 * one makes every caller wait out its full timeout. After `threshold` failures
 * in a row for a key the breaker opens: `allow()` says no for `cooldownMs`,
 * and the caller runs its fallback at once. When the cooldown ends, one call
 * goes through as a probe (the cooldown re-arms at the same moment, so a probe
 * that never reports cannot wedge it open). A success closes it; a failed
 * probe keeps it open for another cooldown. In-process, per key.
 *
 * Chat has no breaker. The extract queue's ProviderCircuit (server/api provider-circuit.ts) is a
 * different job: a database-backed pause of a queue with admin alerts and a
 * probe schedule, not a per-call fail-fast.
 */
type BreakerState = { failures: number; openedAt: number | null };

export class CircuitBreaker {
  private readonly map = new Map<string, BreakerState>();
  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** May a call go out now? */
  allow(key: string): boolean {
    const s = this.map.get(key);
    if (!s || s.openedAt === null) return true;
    if (this.now() - s.openedAt < this.cooldownMs) return false;
    s.openedAt = this.now(); // this call is the probe; the rest wait again
    return true;
  }

  /** A call succeeded: close. Returns true when this closed an open breaker. */
  success(key: string): boolean {
    const wasOpen = this.map.get(key)?.openedAt != null;
    this.map.delete(key);
    return wasOpen;
  }

  /** A call failed. Returns true when this failure opened the breaker. */
  failure(key: string): boolean {
    const s = this.map.get(key) ?? { failures: 0, openedAt: null };
    s.failures += 1;
    const opening = s.openedAt === null && s.failures >= this.threshold;
    if (s.failures >= this.threshold) s.openedAt = this.now();
    this.map.set(key, s);
    return opening;
  }

  isOpen(key: string): boolean {
    return this.map.get(key)?.openedAt != null;
  }

  clear(): void {
    this.map.clear();
  }
}
