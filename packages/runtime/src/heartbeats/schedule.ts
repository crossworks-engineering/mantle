/**
 * Schedule arithmetic — given a heartbeat row, when should it next
 * fire? Pure functions; no DB access. The tick loop calls
 * `computeNextFireAt` after each successful fire (and after skips
 * that should still push the schedule forward).
 *
 * Cron is intentionally NOT implemented in v1 — adding a cron parser
 * dep for a feature we don't yet need is premature. The enum value
 * is reserved in migration 0030; computeNextFireAt throws on
 * `kind:'cron'` until v1.1.
 */

import type { HeartbeatScheduleSpec } from '@mantle/db';

/** Pseudo-random jitter in ±minutes, deterministic per (heartbeatId, fireCount)
 *  so retries reproduce the same offset. Math.random would do for now, but
 *  keeping fires reproducible helps debugging — a flaky test that fired
 *  at 09:07 should fire at 09:07 again. */
function jitterMinutes(seed: string, magnitudeMin: number): number {
  if (magnitudeMin <= 0) return 0;
  // Cheap stable hash. Doesn't need to be cryptographic.
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  // Map to [-magnitudeMin, +magnitudeMin].
  const norm = ((h % 10000) + 10000) % 10000; // 0..9999
  return ((norm / 9999) * 2 - 1) * magnitudeMin;
}

export type ComputeNextFireInput = {
  schedule: HeartbeatScheduleSpec;
  /** Anchor: usually last_fired_at, or created_at if never fired. */
  anchor: Date;
  /** Used to seed jitter for reproducibility. */
  seed?: string;
  /** Hard floor — never schedule before this (used to honour earliest_at). */
  notBefore?: Date | null;
};

/**
 * Returns the next time the heartbeat should fire after `anchor`, or
 * `null` if no further fire is expected (e.g. `once` already passed).
 */
export function computeNextFireAt(input: ComputeNextFireInput): Date | null {
  const { schedule, anchor, notBefore, seed = '' } = input;

  let candidate: Date | null;
  switch (schedule.kind) {
    case 'once': {
      const t = new Date(schedule.at);
      // If the once time is in the past relative to anchor, no further
      // fires — fire() will have handled the actual one-shot.
      candidate = t > anchor ? t : null;
      break;
    }
    case 'interval': {
      const baseMs = schedule.every_minutes * 60_000;
      const jitterMs = jitterMinutes(seed, schedule.jitter_minutes ?? 0) * 60_000;
      candidate = new Date(anchor.getTime() + baseMs + jitterMs);
      break;
    }
    case 'manual': {
      // Manual heartbeats don't auto-schedule; next_fire_at stays null
      // until someone calls the heartbeat_fire tool.
      candidate = null;
      break;
    }
    case 'cron': {
      throw new Error(
        "cron schedule isn't implemented in v1. Use 'interval' or 'once', " +
          'or add cron-parser as a dep and wire it here.',
      );
    }
    default: {
      const _exhaustive: never = schedule;
      throw new Error(`unknown schedule kind: ${JSON.stringify(_exhaustive)}`);
    }
  }

  if (candidate && notBefore && candidate < notBefore) return notBefore;
  return candidate;
}

/** Validate a schedule payload at create/update time. Throws with a
 *  human-readable message on invalid shape. UI calls this before INSERT. */
export function validateSchedule(s: HeartbeatScheduleSpec): void {
  switch (s.kind) {
    case 'once': {
      if (!s.at || Number.isNaN(Date.parse(s.at))) {
        throw new Error("'once' schedule needs an ISO-8601 `at` field.");
      }
      return;
    }
    case 'interval': {
      if (!Number.isFinite(s.every_minutes) || s.every_minutes < 1) {
        throw new Error("'interval' schedule needs `every_minutes` >= 1.");
      }
      if (s.jitter_minutes != null) {
        if (!Number.isFinite(s.jitter_minutes) || s.jitter_minutes < 0) {
          throw new Error('`jitter_minutes` must be >= 0.');
        }
        if (s.jitter_minutes > s.every_minutes / 2) {
          throw new Error('`jitter_minutes` should be <= half of every_minutes.');
        }
      }
      return;
    }
    case 'cron': {
      throw new Error("cron schedule kind isn't supported in v1.");
    }
    case 'manual': {
      return;
    }
    default: {
      const _exhaustive: never = s;
      throw new Error(`unknown schedule kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
