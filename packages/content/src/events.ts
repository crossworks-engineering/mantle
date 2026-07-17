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
 *   nodes.data.recur                'none'|'daily'|'weekly'|'monthly'|'yearly'
 *   nodes.data.recur_until          ISO, optional end-of-series cutoff
 *
 * Under the `events` ltree root. The events-reminders worker polls every
 * 30s for rows where remind_at <= now() AND reminder_sent_at is null and
 * sends a Telegram ping via @mantle/telegram. For a recurring event the
 * worker rolls the single row forward to its next occurrence (re-arming
 * the reminder) instead of marking it sent — see `rollForwardRecurrence`.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';

export type { RecurFreq } from './events-time';

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
  /** Recurrence frequency; 'none' for a one-shot event. */
  recur: RecurFreq;
  /** Optional end-of-series cutoff (ISO). null = repeats until deleted. */
  recurUntil: string | null;
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
    recur: sanitiseRecur(d.recur),
    recurUntil: typeof d.recur_until === 'string' ? d.recur_until : null,
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

type ListEventsOpts = { query?: string; window?: 'upcoming' | 'past' | 'all'; tag?: string };

/** Shared WHERE conditions for event list/count queries. */
function eventConds(ownerId: string, opts: ListEventsOpts) {
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
  return conds;
}

export async function listEvents(
  ownerId: string,
  opts: ListEventsOpts & { limit?: number; offset?: number } = {},
): Promise<EventRow[]> {
  const orderExpr =
    opts.window === 'past'
      ? desc(sql`mantle_iso_to_ts(${nodes.data}->>'starts_at')`)
      : asc(sql`mantle_iso_to_ts(${nodes.data}->>'starts_at')`);
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...eventConds(ownerId, opts)))
    .orderBy(orderExpr)
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

/** Total events matching the same filters as `listEvents` (drives pagination). */
export async function countEvents(ownerId: string, opts: ListEventsOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...eventConds(ownerId, opts)));
  return row?.n ?? 0;
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
  /** Repeat frequency. Omit or 'none' for a one-shot event. */
  recur?: RecurFreq;
  /** Optional ISO cutoff; the series stops once the next occurrence
   *  would fall after this. Ignored when recur is 'none'. */
  recurUntil?: string | null;
  tags?: string[];
};

// Pure helpers live in events-time.ts so vitest can import them
// without pulling in the @mantle/db runtime.
import {
  advanceToNextFuture,
  computeRemindAt,
  sanitiseRecur,
  sanitiseTimezone,
  type RecurFreq,
} from './events-time';

export async function createEvent(ownerId: string, input: CreateEventInput): Promise<EventRow> {
  await ensureRoot(ownerId);
  // Validate ISO. `new Date('garbage')` is invalid; we want to fail clearly
  // rather than write nonsense into the JSON.
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new Error('invalid starts_at');
  const remindMinutes = Math.max(0, Math.floor(input.remindMinutesBefore ?? 0));
  const recur = sanitiseRecur(input.recur);
  const data: Record<string, unknown> = {
    body: input.body ?? '',
    starts_at: startsAt.toISOString(),
    remind_minutes_before: remindMinutes,
    remind_at: computeRemindAt(startsAt.toISOString(), remindMinutes),
    timezone: sanitiseTimezone(input.timezone),
    recur,
  };
  // recur_until is only meaningful for a repeating event.
  if (recur !== 'none' && input.recurUntil) {
    const until = new Date(input.recurUntil);
    if (Number.isNaN(until.getTime())) throw new Error('invalid recur_until');
    data.recur_until = until.toISOString();
  }
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
  if (input.recur !== undefined) {
    const recur = sanitiseRecur(input.recur);
    newData.recur = recur;
    // Turning recurrence off drops the cutoff so a later re-enable
    // doesn't silently inherit a stale end date.
    if (recur === 'none') delete newData.recur_until;
  }
  if (input.recurUntil !== undefined) {
    const stillRecurs = sanitiseRecur(newData.recur) !== 'none';
    if (input.recurUntil && stillRecurs) {
      const until = new Date(input.recurUntil);
      if (Number.isNaN(until.getTime())) throw new Error('invalid recur_until');
      newData.recur_until = until.toISOString();
    } else {
      delete newData.recur_until;
    }
  }
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
    await notifyNodeIngested(id);
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

/**
 * Worker-facing: after a recurring event's reminder fires, roll the
 * single row forward to its next occurrence and re-arm the reminder
 * (clearing reminder_sent_at) instead of marking it permanently sent.
 * Shifts starts_at + ends_at by the occurrence delta and recomputes
 * remind_at. Collapses any backlog of missed occurrences into one hop
 * (see `advanceToNextFuture`).
 *
 * If the next occurrence would fall after `recur_until`, the series is
 * over: we mark it sent (the row stays at the last occurrence, becoming
 * an ordinary past event). For a non-recurring row this just defers to
 * `markReminderSent`, so the worker can call it unconditionally.
 *
 * Note: this does NOT re-fire `node_ingested` — only the time moved, not
 * the content, so there's nothing new for the extractor to index. Keeps
 * recurrence cost-free in LLM terms.
 */
export async function rollForwardRecurrence(eventId: string): Promise<void> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, eventId), eq(nodes.type, 'event')))
    .limit(1);
  if (!node) return;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const recur = sanitiseRecur(d.recur);
  if (recur === 'none') {
    await markReminderSent(eventId);
    return;
  }
  const currentStart = typeof d.starts_at === 'string' ? d.starts_at : null;
  if (!currentStart) {
    await markReminderSent(eventId);
    return;
  }
  const remindMinutes = typeof d.remind_minutes_before === 'number' ? d.remind_minutes_before : 0;
  const nextStart = advanceToNextFuture(currentStart, recur, remindMinutes, Date.now());

  // Series cutoff: stop once the next hit lands past recur_until.
  const until = typeof d.recur_until === 'string' ? new Date(d.recur_until).getTime() : null;
  if (until != null && new Date(nextStart).getTime() > until) {
    await markReminderSent(eventId);
    return;
  }

  const newData: Record<string, unknown> = { ...d };
  newData.starts_at = nextStart;
  // Shift the end by the same delta so duration is preserved.
  if (typeof d.ends_at === 'string') {
    const delta = new Date(nextStart).getTime() - new Date(currentStart).getTime();
    newData.ends_at = new Date(new Date(d.ends_at).getTime() + delta).toISOString();
  }
  newData.remind_at = computeRemindAt(nextStart, remindMinutes);
  delete newData.reminder_sent_at; // re-arm for the next occurrence
  await db.update(nodes).set({ data: newData, updatedAt: new Date() }).where(eq(nodes.id, eventId));
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

// ── External calendar sync ────────────────────────────────────────────────
// Events ingested from an external calendar (ICS feed, Google, Microsoft) are
// ordinary `event` nodes carrying provenance in `data` — so they appear in the
// events UI, search, and the knowledge graph exactly like native events. Dedup
// is by (owner, external_account_id, external_uid). Synced events suppress the
// Mantle reminder (the source calendar owns notifications) by stamping
// `reminder_sent_at` and a 0-minute lead.

export type UpsertExternalEventInput = {
  /** The calendar_accounts row this event came from. */
  externalAccountId: string;
  /** Stable id for this event/occurrence within the source (dedup key). */
  externalUid: string;
  /** Source kind for provenance/UI: 'ics' | 'google' | 'microsoft'. */
  externalSource: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  location?: string | null;
  description?: string;
  timezone?: string;
  tags?: string[];
};

function externalEventData(input: UpsertExternalEventInput): Record<string, unknown> {
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new Error('invalid starts_at');
  const data: Record<string, unknown> = {
    body: input.description ?? '',
    starts_at: startsAt.toISOString(),
    timezone: sanitiseTimezone(input.timezone),
    recur: 'none', // occurrences are expanded by the provider; no roll-forward
    all_day: !!input.allDay,
    // Suppress the Mantle reminder — the external calendar already notifies.
    remind_minutes_before: 0,
    remind_at: startsAt.toISOString(),
    reminder_sent_at: new Date().toISOString(),
    external_uid: input.externalUid,
    external_account_id: input.externalAccountId,
    external_source: input.externalSource,
  };
  if (input.endsAt) {
    const endsAt = new Date(input.endsAt);
    if (!Number.isNaN(endsAt.getTime())) data.ends_at = endsAt.toISOString();
  }
  if (input.location) data.location = input.location.slice(0, 200);
  return data;
}

/** Create or update the event node for an external calendar item. Re-extracts
 *  (re-embeds) only when title/time/location/body actually changed. */
export async function upsertExternalEvent(
  ownerId: string,
  input: UpsertExternalEventInput,
): Promise<EventRow> {
  await ensureRoot(ownerId);
  const title = input.title.trim().slice(0, 200) || 'Untitled event';
  const data = externalEventData(input);

  const [existing] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'event'),
        sql`${nodes.data}->>'external_account_id' = ${input.externalAccountId}`,
        sql`${nodes.data}->>'external_uid' = ${input.externalUid}`,
      ),
    )
    .limit(1);

  if (existing) {
    const old = (existing.data ?? {}) as Record<string, unknown>;
    const contentChanged =
      existing.title !== title ||
      old.starts_at !== data.starts_at ||
      old.ends_at !== data.ends_at ||
      old.location !== data.location ||
      old.body !== data.body;
    if (!contentChanged) return rowOf(existing); // no-op re-sync, no churn

    // Preserve any fields we don't manage; drop stale extractor output.
    const merged: Record<string, unknown> = { ...old, ...data };
    delete merged.summary;
    delete merged.summary_model;
    delete merged.summary_at;
    delete merged.entities;
    const [updated] = await db
      .update(nodes)
      .set({
        title,
        data: merged,
        tags: dedupeTags(input.tags ?? existing.tags ?? []),
        embedding: null,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, existing.id))
      .returning();
    if (!updated) throw new Error('upsertExternalEvent: update returned no row');
    await notifyNodeIngested(existing.id);
    return rowOf(updated);
  }

  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'event',
      title,
      path: EVENTS_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('upsertExternalEvent: insert returned no row');
  return rowOf(row); // INSERT fires node_ingested → extractor
}

/** External UIDs currently stored for a calendar account — used to detect
 *  events deleted upstream (present last sync, gone this sync). */
export async function listExternalEventUids(
  ownerId: string,
  externalAccountId: string,
): Promise<string[]> {
  const rows = await db
    .select({ uid: sql<string>`${nodes.data}->>'external_uid'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'event'),
        sql`${nodes.data}->>'external_account_id' = ${externalAccountId}`,
      ),
    );
  return rows.map((r) => r.uid).filter((u): u is string => !!u);
}

/** Delete synced event nodes for the given external UIDs (upstream removals). */
export async function deleteExternalEvents(
  ownerId: string,
  externalAccountId: string,
  uids: string[],
): Promise<number> {
  if (uids.length === 0) return 0;
  const rows = await db
    .select({ id: nodes.id, uid: sql<string>`${nodes.data}->>'external_uid'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'event'),
        sql`${nodes.data}->>'external_account_id' = ${externalAccountId}`,
      ),
    );
  const drop = new Set(uids);
  const ids = rows.filter((r) => drop.has(r.uid)).map((r) => r.id);
  if (ids.length === 0) return 0;
  await db.delete(nodes).where(inArray(nodes.id, ids));
  return ids.length;
}

/** Remove every synced event for an account (called when a calendar is deleted). */
export async function deleteAllExternalEvents(
  ownerId: string,
  externalAccountId: string,
): Promise<number> {
  const rows = await db
    .delete(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'event'),
        sql`${nodes.data}->>'external_account_id' = ${externalAccountId}`,
      ),
    )
    .returning({ id: nodes.id });
  return rows.length;
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
