import type { CalendarAccount } from '@mantle/db';

/**
 * Provider-agnostic calendar pipeline. A `CalendarProvider` pulls a set of
 * normalized events from one source; the orchestrator (`sync.ts`) upserts them
 * into Mantle's event nodes and reconciles deletions. ICS is the first
 * implementation; Google/Microsoft OAuth providers implement the same interface
 * later. See docs/calendar-ingest.md.
 */

/** One concrete, fully-resolved calendar entry (a single occurrence — recurring
 *  series are expanded by the provider into individual occurrences). */
export interface CalEvent {
  /** Stable id within the source. For a recurring series, include the
   *  occurrence start so each instance is distinct (`<uid>:<iso>`). */
  uid: string;
  title: string;
  /** UTC ISO instant. */
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  location?: string | null;
  description?: string;
  /** IANA tz for display; UTC if unknown. */
  timezone?: string;
  /** 'cancelled' tombstones an event in a delta pull. */
  status?: 'confirmed' | 'cancelled';
}

export interface CalendarPull {
  events: CalEvent[];
  /**
   * true  → `events` is the COMPLETE current set (ICS feed): the orchestrator
   *         deletes stored events whose uid is absent here.
   * false → a delta (API providers): removals arrive as `status: 'cancelled'`;
   *         the orchestrator does not infer deletions from absence.
   */
  fullSet: boolean;
  /** Opaque cursor to persist for the next pull (delta providers). */
  nextCursor?: Record<string, unknown>;
}

export interface CalendarProvider {
  /** Pull events for an account. `cursor` is the persisted `sync_state` (or
   *  undefined on first run). */
  pull(
    account: CalendarAccount,
    cursor: Record<string, unknown> | undefined,
  ): Promise<CalendarPull>;
}
