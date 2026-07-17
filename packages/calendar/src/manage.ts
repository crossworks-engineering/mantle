/** Owner-scoped CRUD for subscribed calendars (the settings UI calls these). */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { calendarAccounts, db, type CalendarAccount } from '@mantle/db';
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
  const [row] = await db
    .insert(calendarAccounts)
    .values({
      id,
      ownerId,
      provider: 'ics',
      displayName: input.displayName.trim().slice(0, 120) || 'Calendar',
      feedUrlEnc: ciphertext,
      color: input.color ?? null,
      enabled: true,
    })
    .returning();
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
  const rows = await db
    .update(calendarAccounts)
    .set({ enabled, lastSyncError: null, updatedAt: new Date() })
    .where(and(eq(calendarAccounts.id, id), eq(calendarAccounts.ownerId, ownerId)))
    .returning({ id: calendarAccounts.id });
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
  await deleteAllExternalEvents(ownerId, id);
  await db.delete(calendarAccounts).where(eq(calendarAccounts.id, id));
  return true;
}
