/**
 * Server-side CRUD + helpers for heartbeats.
 *
 * A heartbeat is a scheduled, stateful skill→agent trigger: when its
 * time comes, the configured agent runs the configured skill with
 * the heartbeat's accumulated state on the configured surface.
 * Heartbeat lifecycle (active → paused / completed / cancelled) is
 * driven by the tick loop in apps/agent (or the operator via the
 * pause/resume buttons here).
 *
 * Gate fields (min_idle_minutes, quiet_hours, cooldown_minutes,
 * earliest_at) are all nullable. Per-heartbeat-only policy — there
 * are NO system-wide defaults. The form pre-fills sensible values
 * when the operator picks the "sensible defaults" preset but the
 * DB itself doesn't apply any.
 */

import type { HeartbeatDTO } from '@mantle/client-types';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  db,
  heartbeats,
  heartbeatFires,
  skills,
  type Heartbeat,
  type HeartbeatFire,
  type HeartbeatQuietHours,
  type HeartbeatScheduleSpec,
  type HeartbeatSurface,
} from '@mantle/db';
import { computeNextFireAt, notifyHeartbeatDue, validateSchedule } from '@mantle/heartbeats';

// Re-export the heartbeat shape types so callers (form actions, API routes) get
// them without importing @mantle/db directly.
export type {
  Heartbeat,
  HeartbeatQuietHours,
  HeartbeatScheduleSpec,
  HeartbeatSurface,
} from '@mantle/db';

/**
 * The summary the CRUD layer returns and `GET /api/heartbeats` serializes.
 * Aliased to the wire DTO in `@mantle/client-types` so the server shape and the
 * client consumer can't drift — if `toSummary` stops matching the contract, this
 * file stops compiling. Dates are ISO strings (see `toSummary`).
 */
export type HeartbeatSummary = HeartbeatDTO;

function toSummary(h: Heartbeat): HeartbeatSummary {
  return {
    id: h.id,
    slug: h.slug,
    name: h.name,
    description: h.description,
    agentSlug: h.agentSlug,
    skillSlug: h.skillSlug,
    scheduleKind: h.scheduleKind,
    schedule: h.schedule,
    surface: h.surface,
    nextFireAt: h.nextFireAt?.toISOString() ?? null,
    lastFiredAt: h.lastFiredAt?.toISOString() ?? null,
    fireCount: h.fireCount,
    maxFires: h.maxFires,
    minIdleMinutes: h.minIdleMinutes,
    quietHours: h.quietHours,
    earliestAt: h.earliestAt?.toISOString() ?? null,
    cooldownMinutes: h.cooldownMinutes,
    state: (h.state ?? {}) as Record<string, unknown>,
    status: h.status,
    completionReason: h.completionReason,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

export async function listHeartbeats(ownerId: string): Promise<HeartbeatSummary[]> {
  const rows = await db
    .select()
    .from(heartbeats)
    .where(eq(heartbeats.ownerId, ownerId))
    .orderBy(asc(heartbeats.slug));
  return rows.map(toSummary);
}

export async function getHeartbeat(
  ownerId: string,
  id: string,
): Promise<HeartbeatSummary | null> {
  const [row] = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.id, id), eq(heartbeats.ownerId, ownerId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * The full owner-scoped Heartbeat row (not the trimmed summary) — `forceFire`
 * and other engine calls need every column. Returns null if not found/owned.
 */
export async function getHeartbeatRow(ownerId: string, id: string): Promise<Heartbeat | null> {
  const [row] = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.id, id), eq(heartbeats.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export type CreateHeartbeatInput = {
  slug: string;
  name: string;
  description?: string | null;
  agentSlug: string;
  skillSlug: string;
  schedule: HeartbeatScheduleSpec;
  surface: HeartbeatSurface;
  minIdleMinutes?: number | null;
  quietHours?: HeartbeatQuietHours | null;
  earliestAt?: Date | null;
  cooldownMinutes?: number | null;
  maxFires?: number | null;
  state?: Record<string, unknown>;
};

export async function createHeartbeat(
  ownerId: string,
  input: CreateHeartbeatInput,
): Promise<HeartbeatSummary> {
  validateSchedule(input.schedule);
  // Compute the first next_fire_at off the schedule. earliestAt acts
  // as the floor so dormant heartbeats stay dormant.
  const now = new Date();
  const anchor = input.earliestAt && input.earliestAt > now ? input.earliestAt : now;
  const nextFireAt = computeNextFireAt({
    schedule: input.schedule,
    anchor,
    notBefore: input.earliestAt ?? null,
  });

  // Resolve initial state. If the operator passed `state` explicitly,
  // use it. Otherwise, fall back to the bound skill's `defaultState`
  // template (typically empty {} unless the skill author filled it
  // in). This is the DRY win that motivated migration 0031: skills
  // declare their expected shape once, every heartbeat using them
  // inherits it without retyping. Bypassed when the operator types
  // their own JSON in the form.
  let initialState: Record<string, unknown> = input.state ?? {};
  if (input.state === undefined) {
    const [skillRow] = await db
      .select({ defaultState: skills.defaultState })
      .from(skills)
      .where(and(eq(skills.ownerId, ownerId), eq(skills.slug, input.skillSlug)))
      .limit(1);
    if (skillRow) initialState = skillRow.defaultState ?? {};
  }

  const [row] = await db
    .insert(heartbeats)
    .values({
      ownerId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      agentSlug: input.agentSlug,
      skillSlug: input.skillSlug,
      scheduleKind: input.schedule.kind,
      schedule: input.schedule,
      surface: input.surface,
      nextFireAt,
      minIdleMinutes: input.minIdleMinutes ?? null,
      quietHours: input.quietHours ?? null,
      earliestAt: input.earliestAt ?? null,
      cooldownMinutes: input.cooldownMinutes ?? null,
      maxFires: input.maxFires ?? null,
      state: initialState,
    })
    .returning();
  if (!row) throw new Error('failed to insert heartbeat');
  // Wake the agent's tick loop so a near-term next_fire_at lands
  // within seconds, not up to 60. Soft-fail; the next regular tick
  // recovers anyway. (NEW-7.)
  void notifyHeartbeatDue(ownerId);
  return toSummary(row);
}

export type UpdateHeartbeatInput = Partial<
  Omit<CreateHeartbeatInput, 'slug'>
> & {
  status?: 'active' | 'paused' | 'completed' | 'cancelled';
};

export async function updateHeartbeat(
  ownerId: string,
  id: string,
  patch: UpdateHeartbeatInput,
): Promise<HeartbeatSummary | null> {
  const next: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.agentSlug !== undefined) next.agentSlug = patch.agentSlug;
  if (patch.skillSlug !== undefined) next.skillSlug = patch.skillSlug;
  if (patch.schedule !== undefined) {
    validateSchedule(patch.schedule);
    next.schedule = patch.schedule;
    next.scheduleKind = patch.schedule.kind;
    // Re-derive next_fire_at when schedule changes. Use now() as anchor.
    next.nextFireAt = computeNextFireAt({
      schedule: patch.schedule,
      anchor: new Date(),
      notBefore: patch.earliestAt ?? null,
    });
  }
  if (patch.surface !== undefined) next.surface = patch.surface;
  if (patch.minIdleMinutes !== undefined) next.minIdleMinutes = patch.minIdleMinutes;
  if (patch.quietHours !== undefined) next.quietHours = patch.quietHours;
  if (patch.earliestAt !== undefined) next.earliestAt = patch.earliestAt;
  if (patch.cooldownMinutes !== undefined) next.cooldownMinutes = patch.cooldownMinutes;
  if (patch.maxFires !== undefined) next.maxFires = patch.maxFires;
  if (patch.state !== undefined) next.state = patch.state;
  if (patch.status !== undefined) {
    next.status = patch.status;
    // Resuming an inactive heartbeat? Recompute its next_fire_at so
    // the tick loop picks it up.
    if (patch.status === 'active' && patch.schedule === undefined) {
      const existing = await getHeartbeat(ownerId, id);
      if (existing) {
        next.nextFireAt = computeNextFireAt({
          schedule: existing.schedule,
          anchor: new Date(),
          notBefore: existing.earliestAt ? new Date(existing.earliestAt) : null,
        });
      }
    } else if (patch.status !== 'active') {
      next.nextFireAt = null;
    }
  }

  const [row] = await db
    .update(heartbeats)
    .set(next)
    .where(and(eq(heartbeats.id, id), eq(heartbeats.ownerId, ownerId)))
    .returning();
  // Wake the tick — covers schedule edits, resume-from-paused, and
  // explicit state changes that might have re-armed the row. Soft-
  // fail; the regular tick recovers. (NEW-7.)
  if (row) void notifyHeartbeatDue(ownerId);
  return row ? toSummary(row) : null;
}

export async function deleteHeartbeat(ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(heartbeats)
    .where(and(eq(heartbeats.id, id), eq(heartbeats.ownerId, ownerId)))
    .returning({ id: heartbeats.id });
  return rows.length > 0;
}

export type HeartbeatFireSummary = {
  id: string;
  firedAt: string;
  traceId: string | null;
  disposition: string;
  stateBefore: Record<string, unknown> | null;
  stateAfter: Record<string, unknown> | null;
  replyText: string | null;
  replySurfaceRef: Record<string, unknown> | null;
  errorMessage: string | null;
};

function toFireSummary(f: HeartbeatFire): HeartbeatFireSummary {
  return {
    id: f.id,
    firedAt: f.firedAt.toISOString(),
    traceId: f.traceId,
    disposition: f.disposition,
    stateBefore: f.stateBefore as Record<string, unknown> | null,
    stateAfter: f.stateAfter as Record<string, unknown> | null,
    replyText: f.replyText,
    replySurfaceRef: f.replySurfaceRef as Record<string, unknown> | null,
    errorMessage: f.errorMessage,
  };
}

/** Most-recent-first fires for a heartbeat. The detail page renders
 *  these as a table; default cap is 50 since heartbeats can fire
 *  often and the audit log only matters for recent activity. */
export async function listHeartbeatFires(
  ownerId: string,
  heartbeatId: string,
  limit = 50,
): Promise<HeartbeatFireSummary[]> {
  // Ownership join via heartbeats — the fires table doesn't carry
  // owner_id directly; the FK cascade keeps the data clean.
  const owns = await getHeartbeat(ownerId, heartbeatId);
  if (!owns) return [];
  const rows = await db
    .select()
    .from(heartbeatFires)
    .where(eq(heartbeatFires.heartbeatId, heartbeatId))
    .orderBy(desc(heartbeatFires.firedAt))
    .limit(limit);
  return rows.map(toFireSummary);
}
