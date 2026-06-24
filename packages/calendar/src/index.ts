/**
 * @mantle/calendar — provider-agnostic calendar ingestion.
 *
 * Syncs external calendars into Mantle's event nodes (searchable, in the events
 * UI, in the knowledge graph). The ICS-feed provider is universal (Google's
 * secret iCal URL, Outlook published calendars, Apple, CalDAV); Google/Microsoft
 * OAuth providers implement the same `CalendarProvider` interface later. See
 * docs/calendar-ingest.md.
 */
export { icsProvider } from './providers/ics';
export { syncCalendarAccount, type CalendarSyncResult } from './sync';
export {
  addIcsFeed,
  listCalendarAccounts,
  setCalendarEnabled,
  deleteCalendarAccount,
} from './manage';
export type { CalEvent, CalendarPull, CalendarProvider } from './types';
