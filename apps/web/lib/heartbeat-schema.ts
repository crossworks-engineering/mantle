/**
 * Zod schemas for the heartbeat mutation endpoints (`POST /api/heartbeats`,
 * `PATCH /api/heartbeats/[id]`). The wire shape is JSON — the settings form
 * builds it directly from its controlled state. The lib (`createHeartbeat` /
 * `updateHeartbeat`) is the authority on schedule validity (`validateSchedule`)
 * and FK enforcement; these schemas just guard structure so a hand-rolled
 * curl/postman call can't sneak a malformed body past.
 *
 * `cron` is intentionally absent from the schedule union — it's read-only in v1
 * (the form locks cron rows), so create/update only accept once/interval/manual.
 */

import { z } from 'zod';
import type { CreateHeartbeatInput, UpdateHeartbeatInput } from '@/lib/heartbeats';

const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string().min(1) }),
  z.object({
    kind: z.literal('interval'),
    every_minutes: z.number().int().min(1),
    jitter_minutes: z.number().int().min(0).optional(),
  }),
  z.object({ kind: z.literal('manual') }),
]);

const Surface = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), chat_id: z.string().min(1) }),
  z.object({ kind: z.literal('web') }),
]);

const QuietHours = z
  .object({
    from: z.string().regex(/^\d{2}:\d{2}$/, 'quiet hours: from must be HH:MM'),
    to: z.string().regex(/^\d{2}:\d{2}$/, 'quiet hours: to must be HH:MM'),
    tz: z.string().nullish(),
  })
  .nullable();

// Shared optional gate fields, identical on create + update.
const gates = {
  description: z.string().max(2000).nullish(),
  minIdleMinutes: z.number().int().min(0).nullable().optional(),
  quietHours: QuietHours.optional(),
  earliestAt: z.string().nullable().optional(), // ISO; converted to Date below
  cooldownMinutes: z.number().int().min(0).nullable().optional(),
  maxFires: z.number().int().min(1).nullable().optional(),
  state: z.record(z.string(), z.unknown()).optional(),
};

export const CreateHeartbeatBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().min(1).max(120),
  agentSlug: z.string().min(1).max(120),
  skillSlug: z.string().min(1).max(120),
  schedule: Schedule,
  surface: Surface,
  ...gates,
});

export const UpdateHeartbeatBody = z.object({
  name: z.string().min(1).max(120).optional(),
  agentSlug: z.string().min(1).max(120).optional(),
  skillSlug: z.string().min(1).max(120).optional(),
  schedule: Schedule.optional(),
  surface: Surface.optional(),
  status: z.enum(['active', 'paused', 'completed', 'cancelled']).optional(),
  ...gates,
});

/** ISO `earliestAt` → `Date` (the lib input takes a Date). */
function earliest(at: string | null | undefined): Date | null | undefined {
  if (at === undefined) return undefined;
  if (at === null) return null;
  return new Date(at);
}

export function toCreateInput(body: z.infer<typeof CreateHeartbeatBody>): CreateHeartbeatInput {
  return {
    slug: body.slug,
    name: body.name,
    description: body.description ?? null,
    agentSlug: body.agentSlug,
    skillSlug: body.skillSlug,
    schedule: body.schedule,
    surface: body.surface,
    minIdleMinutes: body.minIdleMinutes ?? null,
    quietHours: body.quietHours ?? null,
    earliestAt: earliest(body.earliestAt) ?? null,
    cooldownMinutes: body.cooldownMinutes ?? null,
    maxFires: body.maxFires ?? null,
    ...(body.state !== undefined ? { state: body.state } : {}),
  };
}

/** Only forward the keys the client actually sent, so the lib's set-map leaves
 *  the rest untouched (a status-only PATCH won't clobber the schedule). */
export function toUpdateInput(body: z.infer<typeof UpdateHeartbeatBody>): UpdateHeartbeatInput {
  const patch: UpdateHeartbeatInput = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description ?? null;
  if (body.agentSlug !== undefined) patch.agentSlug = body.agentSlug;
  if (body.skillSlug !== undefined) patch.skillSlug = body.skillSlug;
  if (body.schedule !== undefined) patch.schedule = body.schedule;
  if (body.surface !== undefined) patch.surface = body.surface;
  if (body.minIdleMinutes !== undefined) patch.minIdleMinutes = body.minIdleMinutes;
  if (body.quietHours !== undefined) patch.quietHours = body.quietHours;
  if (body.earliestAt !== undefined) patch.earliestAt = earliest(body.earliestAt);
  if (body.cooldownMinutes !== undefined) patch.cooldownMinutes = body.cooldownMinutes;
  if (body.maxFires !== undefined) patch.maxFires = body.maxFires;
  if (body.state !== undefined) patch.state = body.state;
  if (body.status !== undefined) patch.status = body.status;
  return patch;
}
