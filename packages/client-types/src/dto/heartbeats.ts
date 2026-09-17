/**
 * @mantle/client-types · heartbeats
 *
 * Heartbeats — the brain on its own clock.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

// ── Heartbeats ─────────────────────────────────────────────────────────────────

/** A heartbeat's schedule (jsonb). `cron` is read-only in v1 (the form locks it);
 *  create/update only accept once/interval/manual. `at` is an ISO string. */
export type HeartbeatScheduleSpecDTO =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; every_minutes: number; jitter_minutes?: number }
  | { kind: 'cron'; expr: string }
  | { kind: 'manual' };

/** Where a heartbeat's reply is delivered (jsonb). */
export type HeartbeatSurfaceDTO = { kind: 'telegram'; chat_id: string } | { kind: 'web' };

/** Optional quiet-hours window (jsonb). null tz = use the profile timezone. */
export interface HeartbeatQuietHoursDTO {
  from: string;
  to: string;
  tz?: string | null;
}

/** A heartbeat as returned by `GET /api/heartbeats(/[id])`. Dates are ISO
 *  strings. The server aliases its `HeartbeatSummary` to this so the wire shape
 *  and the consuming client can't drift. */
/** Alias kept for the heartbeats settings screens (formerly @server/lib/heartbeats). */
export type HeartbeatSummary = HeartbeatDTO;

export interface HeartbeatDTO {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  agentSlug: string;
  skillSlug: string;
  scheduleKind: 'once' | 'interval' | 'cron' | 'manual';
  schedule: HeartbeatScheduleSpecDTO;
  surface: HeartbeatSurfaceDTO;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  fireCount: number;
  maxFires: number | null;
  minIdleMinutes: number | null;
  quietHours: HeartbeatQuietHoursDTO | null;
  earliestAt: string | null;
  cooldownMinutes: number | null;
  state: Record<string, unknown>;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  completionReason: string | null;
  createdAt: string;
  updatedAt: string;
}
