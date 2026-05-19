/**
 * Events surface (calendar items with reminders). An event is a `nodes`
 * row with type='event':
 *
 *   nodes.title                     short label ("Meeting with Alex")
 *   nodes.data.body                 freeform description (extractor reads)
 *   nodes.data.starts_at            ISO timestamp
 *   nodes.data.ends_at              ISO timestamp (optional)
 *   nodes.data.location             freeform string (optional)
 *   nodes.data.remind_minutes_before  number, default 0
 *   nodes.data.remind_at            ISO, computed = starts_at - n minutes
 *   nodes.data.reminder_sent_at     ISO once the worker has delivered it
 *
 * Under the `events` ltree root. The events-reminders worker polls every
 * 30s for rows where remind_at <= now() AND reminder_sent_at is null and
 * sends a Telegram ping via @mantle/telegram.
 */
import { and, asc, desc, eq, gte, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { db, nodes, type Node } from '@mantle/db';

export const EVENTS_ROOT_LABEL = 'events';

export type EventRow = {
  id: string;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  remindMinutesBefore: number;
  remindAt: string;
  reminderSentAt: string | null;
  /** IANA timezone (e.g. "Africa/Johannesburg") captured from the
   *  client at create time. Used for display only — `starts_at` is
   *  always a UTC instant so the reminder fires at the right moment
   *  regardless of where the agent process or DB run. Defaults to
   *  'UTC' if the client didn't supply one. */
  timezone: string;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowOf(n: Node): EventRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const startsAt = typeof d.starts_at === 'string' ? d.starts_at : new Date().toISOString();
  const remind = typeof d.remind_minutes_before === 'number' ? d.remind_minutes_before : 0;
  const remindAt =
    typeof d.remind_at === 'string'
      ? d.remind_at
      : new Date(new Date(startsAt).getTime() - remind * 60_000).toISOString();
  return {
    id: n.id,
    title: n.title,
    body: typeof d.body === 'string' ? d.body : '',
    startsAt,
    endsAt: typeof d.ends_at === 'string' ? d.ends_at : null,
    location: typeof d.location === 'string' ? d.location : null,
    remindMinutesBefore: remind,
    remindAt,
    reminderSentAt: typeof d.reminder_sent_at === 'string' ? d.reminder_sent_at : null,
    timezone: typeof d.timezone === 'string' && d.timezone.length > 0 ? d.timezone : 'UTC',
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Events',
      slug: EVENTS_ROOT_LABEL,
      path: EVENTS_ROOT_LABEL,
      data: {
        description: 'Calendar events. The reminder worker pings Telegram at remind_at.',
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

export async function listEvents(
  ownerId: string,
  opts: { query?: string; window?: 'upcoming' | 'past' | 'all'; tag?: string } = {},
): Promise<EventRow[]> {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'event')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'body' ilike ${q}`,
      sql`${nodes.data}->>'location' ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  // Use the IMMUTABLE wrapper `mantle_iso_to_ts` (declared in 0025) so
  // the expression matches the partial index. Plain `::timestamptz` is
  // STABLE and won't be picked by the planner even though the cast
  // returns the same value.
  if (opts.window === 'upcoming') {
    conds.push(sql`mantle_iso_to_ts(${nodes.data}->>'starts_at') >= now()`);
  } else if (opts.window === 'past') {
    conds.push(sql`mantle_iso_to_ts(${nodes.data}->>'starts_at') < now()`);
  }
  const orderExpr =
    opts.window === 'past'
      ? desc(sql`mantle_iso_to_ts(${nodes.data}->>'starts_at')`)
      : asc(sql`mantle_iso_to_ts(${nodes.data}->>'starts_at')`);
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...conds))
    .orderBy(orderExpr)
    .limit(500);
  return rows.map(rowOf);
}

export async function getEvent(ownerId: string, id: string): Promise<EventRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'event')))
    .limit(1);
  return row ? rowOf(row) : null;
}

export type CreateEventInput = {
  title: string;
  body?: string;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
  remindMinutesBefore?: number;
  /** IANA tz string from the client (e.g. `Intl.DateTimeFormat().
   *  resolvedOptions().timeZone`). Display only; falls back to 'UTC'. */
  timezone?: string;
  tags?: string[];
};

// Pure helpers live in events-time.ts so vitest can import them
// without pulling in the @mantle/db runtime.
import { computeRemindAt, sanitiseTimezone } from './events-time';

export async function createEvent(ownerId: string, input: CreateEventInput): Promise<EventRow> {
  await ensureRoot(ownerId);
  // Validate ISO. `new Date('garbage')` is invalid; we want to fail clearly
  // rather than write nonsense into the JSON.
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new Error('invalid starts_at');
  const remindMinutes = Math.max(0, Math.floor(input.remindMinutesBefore ?? 0));
  const data: Record<string, unknown> = {
    body: input.body ?? '',
    starts_at: startsAt.toISOString(),
    remind_minutes_before: remindMinutes,
    remind_at: computeRemindAt(startsAt.toISOString(), remindMinutes),
    timezone: sanitiseTimezone(input.timezone),
  };
  if (input.endsAt) {
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime())) throw new Error('invalid ends_at');
    data.ends_at = endsAt.toISOString();
  }
  if (input.location) data.location = input.location.slice(0, 200);
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'event',
      title: input.title.trim().slice(0, 200) || 'Untitled event',
      path: EVENTS_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createEvent: insert returned no row');
  return rowOf(row);
}

export type UpdateEventInput = Partial<CreateEventInput>;

export async function updateEvent(
  ownerId: string,
  id: string,
  input: UpdateEventInput,
): Promise<EventRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'event')))
    .limit(1);
  if (!node) return null;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  let startsAtChanged = false;
  if (input.startsAt !== undefined) {
    const d = new Date(input.startsAt);
    if (Number.isNaN(d.getTime())) throw new Error('invalid starts_at');
    newData.starts_at = d.toISOString();
    startsAtChanged = true;
  }
  if (input.endsAt !== undefined) {
    if (input.endsAt) {
      const d = new Date(input.endsAt);
      if (Number.isNaN(d.getTime())) throw new Error('invalid ends_at');
      newData.ends_at = d.toISOString();
    } else {
      delete newData.ends_at;
    }
  }
  if (input.location !== undefined) {
    if (input.location) newData.location = input.location.slice(0, 200);
    else delete newData.location;
  }
  if (input.body !== undefined) newData.body = input.body;
  if (input.remindMinutesBefore !== undefined) {
    newData.remind_minutes_before = Math.max(0, Math.floor(input.remindMinutesBefore));
  }
  if (input.timezone !== undefined) newData.timezone = sanitiseTimezone(input.timezone);
  // Recompute remind_at if starts_at OR lead time moved. Clear
  // reminder_sent_at when the reminder time itself moves into the
  // future, so the worker fires the new ping.
  if (startsAtChanged || input.remindMinutesBefore !== undefined) {
    const startsAt = String(newData.starts_at);
    const minutes = Number(newData.remind_minutes_before ?? 0);
    const nextRemindAt = computeRemindAt(startsAt, minutes);
    newData.remind_at = nextRemindAt;
    if (
      typeof newData.reminder_sent_at === 'string' &&
      new Date(nextRemindAt).getTime() > Date.now()
    ) {
      delete newData.reminder_sent_at;
    }
  }
  const contentChanged =
    input.title !== undefined ||
    input.body !== undefined ||
    input.startsAt !== undefined ||
    input.endsAt !== undefined ||
    input.location !== undefined;
  if (contentChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }
  const [updated] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled event' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(contentChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateEvent: update returned no row');
  if (contentChanged) {
    await db.execute(sql`SELECT pg_notify('node_ingested', ${id}::text)`);
  }
  return rowOf(updated);
}

export async function deleteEvent(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'event')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id));
  return true;
}

/**
 * Worker-facing: events whose remind_at <= now and which haven't been
 * sent yet. The worker calls this on every tick. Owner-scoped because
 * we look up the destination Telegram chat per-owner.
 */
export async function listDueReminders(ownerId: string, limit = 50): Promise<EventRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'event'),
        sql`mantle_iso_to_ts(${nodes.data}->>'remind_at') <= now()`,
        sql`${nodes.data}->>'reminder_sent_at' is null`,
      ),
    )
    .orderBy(asc(sql`mantle_iso_to_ts(${nodes.data}->>'remind_at')`))
    .limit(limit);
  return rows.map(rowOf);
}

/** Mark an event's reminder as delivered. Idempotent. */
export async function markReminderSent(eventId: string): Promise<void> {
  await db
    .update(nodes)
    .set({
      data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify({ reminder_sent_at: new Date().toISOString() })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, eventId));
}

/** All owner IDs that have at least one event row. The reminder worker
 *  loops over these so it doesn't need ALLOWED_USER_ID hard-coded. */
export async function ownersWithEvents(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ ownerId: nodes.ownerId })
    .from(nodes)
    .where(eq(nodes.type, 'event'));
  return rows.map((r) => r.ownerId);
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
