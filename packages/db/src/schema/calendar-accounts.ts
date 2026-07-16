import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * A subscribed external calendar source. Provider-agnostic: the first
 * implementation is `ics` (an iCalendar feed URL — covers Google's secret iCal
 * address, Outlook published calendars, Apple, CalDAV, Fastmail…). Future
 * `google` / `microsoft` OAuth providers add their own token columns and plug
 * into the same `CalendarProvider` interface; the synced events land the same
 * way regardless. See docs/calendar-ingest.md.
 *
 * Owner-scoped list (a user can subscribe many calendars). The feed URL is a
 * credential (Google's secret address grants read access) so it's sealed with
 * @mantle/crypto (AAD = row id), like tailscale_config / api_keys.
 */
export const calendarAccounts = pgTable(
  'calendar_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** 'ics' (future: 'google' | 'microsoft'). */
    provider: text('provider').notNull(),
    displayName: text('display_name').notNull(),
    /** Sealed iCalendar feed URL for provider='ics' (AAD = row id). */
    feedUrlEnc: bytea('feed_url_enc'),
    /** Optional UI accent (hex) so multiple calendars are distinguishable. */
    color: text('color'),
    /** Opt-in, like every other source. */
    enabled: boolean('enabled').default(true).notNull(),
    /** Provider sync cursor (delta token for API providers); ICS re-pulls in
     *  full and dedups, so it leaves this empty. */
    syncState: jsonb('sync_state')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    /** Events upserted on the last successful sync (surfaced in the UI). */
    lastEventCount: integer('last_event_count'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('calendar_accounts_owner_idx').on(t.ownerId)],
);

export type CalendarAccount = typeof calendarAccounts.$inferSelect;
export type NewCalendarAccount = typeof calendarAccounts.$inferInsert;
