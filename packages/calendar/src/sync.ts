/**
 * Calendar sync orchestrator. Pulls from a provider and reconciles the result
 * into Mantle event nodes: upsert confirmed events, delete the ones that
 * disappeared (full-set providers) or were cancelled (delta providers), then
 * persist sync state. Provider-agnostic — the same flow serves ICS today and
 * Google/Microsoft OAuth providers later.
 */
import { eq } from 'drizzle-orm';
import { calendarAccounts, db, type CalendarAccount } from '@mantle/db';
import { deleteExternalEvents, listExternalEventUids, upsertExternalEvent } from '@mantle/content';
import { icsProvider } from './providers/ics';
import type { CalendarProvider } from './types';

function providerFor(account: CalendarAccount): CalendarProvider {
  switch (account.provider) {
    case 'ics':
      return icsProvider;
    default:
      throw new Error(`unsupported calendar provider: ${account.provider}`);
  }
}

/** Slug of the calendar name, applied as a tag so synced events are filterable
 *  by source in the events UI. */
function calTag(name: string): string {
  const t = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return t || 'calendar';
}

export interface CalendarSyncResult {
  pulled: number;
  upserted: number;
  removed: number;
}

export async function syncCalendarAccount(account: CalendarAccount): Promise<CalendarSyncResult> {
  const provider = providerFor(account);
  const pull = await provider.pull(account, account.syncState ?? undefined);
  const tag = calTag(account.displayName);

  let upserted = 0;
  const freshUids = new Set<string>();
  for (const ev of pull.events) {
    if (ev.status === 'cancelled') continue; // reconciled below
    freshUids.add(ev.uid);
    await upsertExternalEvent(account.ownerId, {
      externalAccountId: account.id,
      externalUid: ev.uid,
      externalSource: account.provider,
      title: ev.title,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      allDay: ev.allDay,
      location: ev.location,
      description: ev.description,
      timezone: ev.timezone,
      tags: [tag],
    });
    upserted++;
  }

  // Deletions: full-set providers (ICS) → stored uids absent from this pull;
  // delta providers → explicit cancellations.
  let removed = 0;
  if (pull.fullSet) {
    const stored = await listExternalEventUids(account.ownerId, account.id);
    const gone = stored.filter((u) => !freshUids.has(u));
    removed = await deleteExternalEvents(account.ownerId, account.id, gone);
  } else {
    const cancelled = pull.events.filter((e) => e.status === 'cancelled').map((e) => e.uid);
    removed = await deleteExternalEvents(account.ownerId, account.id, cancelled);
  }

  await db
    .update(calendarAccounts)
    .set({
      syncState: (pull.nextCursor ?? account.syncState) as Record<string, unknown>,
      lastEventCount: upserted,
      lastSyncAt: new Date(),
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(calendarAccounts.id, account.id));

  return { pulled: pull.events.length, upserted, removed };
}
