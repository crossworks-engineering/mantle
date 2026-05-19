'use server';

/**
 * Server actions for /settings/heartbeats. Thin wrappers over
 * apps/web/lib/heartbeats CRUD + a couple of operator-action
 * shortcuts (pause/resume/fire-now/cancel).
 *
 * Each form action validates inputs minimally and lets the CRUD lib
 * do the rest (schedule shape validation via @mantle/heartbeats'
 * validateSchedule, FK enforcement at the DB).
 */

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/lib/auth';
import {
  createHeartbeat,
  deleteHeartbeat,
  getHeartbeat,
  updateHeartbeat,
  type CreateHeartbeatInput,
} from '@/lib/heartbeats';
import type {
  HeartbeatScheduleSpec,
  HeartbeatSurface,
  HeartbeatQuietHours,
} from '@mantle/db';
import { forceFire } from '@mantle/heartbeats';
import { db, heartbeats } from '@mantle/db';
import { and, eq } from 'drizzle-orm';

function parseSchedule(formData: FormData): HeartbeatScheduleSpec {
  const kind = String(formData.get('schedule_kind') ?? '');
  switch (kind) {
    case 'once': {
      const at = String(formData.get('schedule_at') ?? '');
      if (!at) throw new Error("'once' schedule: pick a date+time.");
      return { kind: 'once', at: new Date(at).toISOString() };
    }
    case 'interval': {
      const every = Number(formData.get('schedule_every_minutes'));
      const jitter = Number(formData.get('schedule_jitter_minutes')) || 0;
      if (!Number.isFinite(every) || every < 1) {
        throw new Error("'interval' schedule: every_minutes must be >= 1.");
      }
      return { kind: 'interval', every_minutes: every, jitter_minutes: jitter };
    }
    case 'manual':
      return { kind: 'manual' };
    default:
      throw new Error(`unknown schedule kind: ${kind}`);
  }
}

function parseSurface(formData: FormData): HeartbeatSurface {
  const kind = String(formData.get('surface_kind') ?? 'telegram');
  if (kind === 'telegram') {
    const chatId = String(formData.get('surface_chat_id') ?? '').trim();
    if (!chatId) throw new Error('Telegram surface: chat_id required.');
    return { kind: 'telegram', chat_id: chatId };
  }
  return { kind: 'web' };
}

function parseQuietHours(formData: FormData): HeartbeatQuietHours | null {
  const from = String(formData.get('quiet_from') ?? '').trim();
  const to = String(formData.get('quiet_to') ?? '').trim();
  if (!from && !to) return null;
  if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) {
    throw new Error('Quiet hours: from/to must be HH:MM (or both blank).');
  }
  const tz = String(formData.get('quiet_tz') ?? '').trim() || null;
  return { from, to, tz };
}

function nullableInt(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key}: must be a non-negative integer or blank.`);
  return n;
}

function parseState(formData: FormData): Record<string, unknown> | undefined {
  // Form sends 'state' as a JSON string (already validated client-side).
  // Re-validate server-side so a hand-rolled curl/postman call can't
  // sneak past. Returns undefined when not provided so the lib falls
  // back to its default ({}).
  const raw = String(formData.get('state') ?? '').trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`state JSON invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('state must be a JSON object (not array, not primitive).');
  }
  return parsed as Record<string, unknown>;
}

function buildInput(formData: FormData): CreateHeartbeatInput {
  const slug = String(formData.get('slug') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  const agentSlug = String(formData.get('agent_slug') ?? '').trim();
  const skillSlug = String(formData.get('skill_slug') ?? '').trim();
  if (!slug || !name || !agentSlug || !skillSlug) {
    throw new Error('slug, name, agent, and skill are all required.');
  }
  const schedule = parseSchedule(formData);
  const surface = parseSurface(formData);
  const earliestRaw = String(formData.get('earliest_at') ?? '').trim();
  const earliestAt = earliestRaw ? new Date(earliestRaw) : null;
  const state = parseState(formData);
  return {
    slug,
    name,
    description,
    agentSlug,
    skillSlug,
    schedule,
    surface,
    minIdleMinutes: nullableInt(formData, 'min_idle_minutes'),
    quietHours: parseQuietHours(formData),
    earliestAt,
    cooldownMinutes: nullableInt(formData, 'cooldown_minutes'),
    maxFires: nullableInt(formData, 'max_fires'),
    ...(state !== undefined ? { state } : {}),
  };
}

export async function createHeartbeatAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  await createHeartbeat(user.id, buildInput(formData));
  revalidatePath('/settings/heartbeats');
}

export async function updateHeartbeatAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  const input = buildInput(formData);
  await updateHeartbeat(user.id, id, input);
  revalidatePath('/settings/heartbeats');
  revalidatePath(`/heartbeats/${id}`);
}

export async function deleteHeartbeatAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  await deleteHeartbeat(user.id, id);
  revalidatePath('/settings/heartbeats');
}

export async function toggleHeartbeatAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const id = String(formData.get('id') ?? '');
  const desired = String(formData.get('status') ?? '') as
    | 'active'
    | 'paused'
    | 'completed'
    | 'cancelled';
  if (!id || !desired) throw new Error('id + status required');
  await updateHeartbeat(user.id, id, { status: desired });
  revalidatePath('/settings/heartbeats');
  revalidatePath(`/heartbeats/${id}`);
}

export async function fireNowAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  // Reload via the schema directly so we hand forceFire the full
  // Heartbeat row shape (the lib summary trims some fields).
  const [row] = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.ownerId, user.id), eq(heartbeats.id, id)))
    .limit(1);
  if (!row) throw new Error('heartbeat not found');
  await forceFire(row);
  revalidatePath('/settings/heartbeats');
  revalidatePath(`/heartbeats/${id}`);
}

export async function ensureHeartbeatOwnership(id: string): Promise<void> {
  const user = await requireOwner();
  const row = await getHeartbeat(user.id, id);
  if (!row) throw new Error('heartbeat not found');
}
