/**
 * Pure read-side shaping for GET /api/assistant/turn/[turnId]/suggestion,
 * extracted from the route so the 204-vs-200 decision is unit-testable (there
 * is no DB-backed route-test convention in this repo; the route itself stays a
 * thin owner-gated select around this).
 */

export type SuggestionPayload = { suggestion: string; suggestedAt?: string };

/**
 * Map an outbound row's `data` jsonb (or null when the row doesn't exist /
 * isn't the caller's; the query is owner-scoped) to the response payload.
 * Null means 204: absent row, no suggestion written yet, guards declined, or
 * junk where the suggestion should be.
 */
export function suggestionPayload(data: unknown): SuggestionPayload | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { suggestion?: unknown; suggestedAt?: unknown };
  const suggestion = typeof d.suggestion === 'string' ? d.suggestion.trim() : '';
  if (!suggestion) return null;
  return {
    suggestion,
    ...(typeof d.suggestedAt === 'string' ? { suggestedAt: d.suggestedAt } : {}),
  };
}
