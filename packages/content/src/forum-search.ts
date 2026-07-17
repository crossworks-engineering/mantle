/**
 * Pure helpers for the forum search — kept free of DB imports so they can be
 * unit-tested without a database (the forum-visibility.ts pattern).
 */

/**
 * Build a short excerpt centred on the first case-insensitive hit of `query`
 * in `body`, with ellipses where the body is clipped. Falls back to the head
 * of the body when `indexOf` can't locate the hit — reachable because the SQL
 * ILIKE that selected the row treats `%`/`_` as wildcards, so a query
 * containing them can match rows this plain substring search cannot.
 */
export function matchSnippet(body: string, query: string, ctx = 60): string {
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return body.slice(0, ctx * 2).trim();
  const start = Math.max(0, idx - ctx);
  const end = Math.min(body.length, idx + query.length + ctx);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}
