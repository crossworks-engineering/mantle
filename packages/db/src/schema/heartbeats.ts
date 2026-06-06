import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Heartbeats: scheduled, stateful skill→agent triggers. Lets the assistant
 * act proactively — e.g. "ask the user about their family every other day
 * until you've covered all topics, then stop". See docs/heartbeats.md
 * for the full design and migration 0030 for the SQL.
 */

export const heartbeatStatus = pgEnum('heartbeat_status', [
  'active',
  'paused',
  'completed',
  'cancelled',
]);

export const heartbeatSchedule = pgEnum('heartbeat_schedule', [
  'once',
  'interval',
  'cron',
  'manual',
]);

/** Per-schedule-kind payload. Validated at create/update time. */
export type HeartbeatScheduleSpec =
  | { kind: 'once'; at: string /* ISO-8601 */ }
  | { kind: 'interval'; every_minutes: number; jitter_minutes?: number }
  | { kind: 'cron'; expr: string /* 5-field crontab */ }
  | { kind: 'manual' };

/** Where the agent's reply goes. Mirrors @mantle/tools surface shape. */
export type HeartbeatSurface =
  | { kind: 'telegram'; chat_id: string }
  | { kind: 'web' };

/** Optional quiet-hours window. null tz = use profile.preferences.timezone. */
export type HeartbeatQuietHours = {
  from: string; // 'HH:MM'
  to: string;   // 'HH:MM'
  tz?: string | null;
};

export const heartbeats = pgTable(
  'heartbeats',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),

    agentSlug: text('agent_slug').notNull(),
    skillSlug: text('skill_slug').notNull(),

    scheduleKind: heartbeatSchedule('schedule_kind').notNull(),
    schedule: jsonb('schedule').$type<HeartbeatScheduleSpec>().notNull(),
    nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    fireCount: integer('fire_count').default(0).notNull(),
    maxFires: integer('max_fires'),

    surface: jsonb('surface').$type<HeartbeatSurface>().notNull(),

    /** Gates — all nullable. null = no gate of this kind. No system
     *  defaults; the form makes the choice explicit per heartbeat. */
    minIdleMinutes: integer('min_idle_minutes'),
    quietHours: jsonb('quiet_hours').$type<HeartbeatQuietHours>(),
    earliestAt: timestamp('earliest_at', { withTimezone: true }),
    cooldownMinutes: integer('cooldown_minutes'),

    /** Free-form per skill. Mutated by heartbeat_update_state tool. */
    state: jsonb('state').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    status: heartbeatStatus('status').default('active').notNull(),
    completionReason: text('completion_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('heartbeats_owner_slug_uq').on(t.ownerId, t.slug),
    index('heartbeats_owner_status_idx').on(t.ownerId, t.status),
    // heartbeats_due_idx is a partial index, emitted by SQL migration 0030.
  ],
);

export type Heartbeat = typeof heartbeats.$inferSelect;
export type NewHeartbeat = typeof heartbeats.$inferInsert;

/** Dispositions recorded on heartbeat_fires.disposition.
 *
 *  Operator triage at-a-glance:
 *
 *    fired              — agent ran + reply delivered (happy path)
 *    fired_undelivered  — agent ran + reply text computed, but the
 *                         surface refused (e.g. no enabled Telegram
 *                         account). LLM cost was spent; user got
 *                         nothing. State still updated.
 *    completed          — same as fired, but a tool flipped
 *                         status=completed (heartbeat done)
 *    skipped_*          — gate rejected (idle / quiet / cooldown /
 *                         earliest). No work, no cost.
 *    auto_paused        — config error caught BEFORE any work
 *                         (agent missing, skill missing, key
 *                         undecryptable). Heartbeat moved to
 *                         status=paused; operator must intervene.
 *    error              — transient runtime failure mid-fire. Will
 *                         retry on the next tick after a short
 *                         backoff. Distinct from auto_paused so the
 *                         operator can tell "will fix itself" from
 *                         "I need to look at this".
 *
 *  Disposition is stored as `text` (not an enum) so adding new
 *  values is a TypeScript-only change. The UI label map in
 *  /heartbeats/[id] should cover every value or it'll fall through
 *  to the raw string.
 */
export type HeartbeatFireDisposition =
  | 'fired'
  | 'fired_undelivered'
  | 'skipped_idle'
  | 'skipped_quiet'
  | 'skipped_cooldown'
  | 'skipped_earliest'
  | 'completed'
  | 'auto_paused'
  | 'error';

export const heartbeatFires = pgTable(
  'heartbeat_fires',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    heartbeatId: uuid('heartbeat_id').notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow().notNull(),
    /** null on skips — no trace was opened. */
    traceId: uuid('trace_id'),
    disposition: text('disposition').$type<HeartbeatFireDisposition>().notNull(),
    stateBefore: jsonb('state_before').$type<Record<string, unknown> | null>(),
    stateAfter: jsonb('state_after').$type<Record<string, unknown> | null>(),
    replyText: text('reply_text'),
    replySurfaceRef: jsonb('reply_surface_ref').$type<Record<string, unknown> | null>(),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('heartbeat_fires_hb_idx').on(t.heartbeatId, t.firedAt),
    index('heartbeat_fires_disposition_idx').on(t.disposition, t.firedAt),
  ],
);

export type HeartbeatFire = typeof heartbeatFires.$inferSelect;
export type NewHeartbeatFire = typeof heartbeatFires.$inferInsert;
