/** Owner-scoped CRUD for subscribed calendars (the settings UI calls these). */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { calendarAccounts, db, onNarrowSpots, type CalendarAccount } from '@mantle/db';
import { seal } from '@mantle/crypto';
import { deleteAllExternalEvents } from '@mantle/content';

/** Subscribe to an iCalendar feed URL. The URL is sealed at rest (AAD = row id);
 *  the UI never sees it again. */
export async function addIcsFeed(
  ownerId: string,
  input: { displayName: string; url: string; color?: string | null },
): Promise<CalendarAccount> {
  const id = randomUUID();
  const { ciphertext } = seal(input.url.trim(), id);
  const values = {
    id,
    ownerId,
    provider: 'ics',
    displayName: input.displayName.trim().slice(0, 120) || 'Calendar',
    feedUrlEnc: ciphertext,
    color: input.color ?? null,
    enabled: true,
  };
  const write = () => db.insert(calendarAccounts).values(values).returning();
  // A new feed starts on (it syncs, its events are ingested): not the
  // narrow login's (0324: the off-only rule meets an insert too), so the
  // full-route spot feed-enable, as a turn-on is.
  const [row] = await onNarrowSpots(calendarAccounts, 'insert', values, write);
  if (!row) throw new Error('addIcsFeed: insert returned no row');
  return row;
}

/** List a user's subscribed calendars (newest first). Never returns the URL. */
export function listCalendarAccounts(ownerId: string): Promise<CalendarAccount[]> {
  return db
    .select()
    .from(calendarAccounts)
    .where(eq(calendarAccounts.ownerId, ownerId))
    .orderBy(desc(calendarAccounts.createdAt));
}

export async function setCalendarEnabled(
  ownerId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const set = { enabled, lastSyncError: null, updatedAt: new Date() };
  const write = () =>
    db
      .update(calendarAccounts)
      .set(set)
      .where(and(eq(calendarAccounts.id, id), eq(calendarAccounts.ownerId, ownerId)))
      .returning({ id: calendarAccounts.id });
  // A turn-on (the feed syncs again, its events are ingested) is not the
  // narrow login's (0323: enabled only off): the full-route spot
  // feed-enable. A switch off stays on the narrow login.
  const rows = await onNarrowSpots(calendarAccounts, 'update', set, write);
  return rows.length > 0;
}

/** Unsubscribe: remove the calendar and all events it synced. */
export async function deleteCalendarAccount(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: calendarAccounts.id })
    .from(calendarAccounts)
    .where(and(eq(calendarAccounts.id, id), eq(calendarAccounts.ownerId, ownerId)))
    .limit(1);
  if (!row) return false;
  // The synced events are items: on the calendar area's narrow exit the
  // structure definer removes them (packages/db gateway/structure-item.ts).
  await deleteAllExternalEvents(ownerId, id);
  await db.delete(calendarAccounts).where(eq(calendarAccounts.id, id));
  return true;
}
