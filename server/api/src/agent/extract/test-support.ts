/**
 * Shared helper for the extractor tests. NOT a test file (no `.test.ts`), so
 * vitest does not collect it.
 *
 * The extractor's writes are drizzle `sql` templates and composed conditions,
 * which cannot be JSON.stringify'd (they hold table references, so the graph is
 * circular) and whose interesting content sits in three different shapes:
 *
 *   - bound params           `eq(nodes.id, 'n1')`      → { value, encoder }
 *   - literal chunks         `- 'extract_incomplete'`  → { value: string[] }
 *   - param LISTS            `inArray(nodes.id, ids)`  → a bare Array of params
 *
 * A walker that misses any one of them reports an empty result, which reads as
 * "the clause has no owner id in it" — a passing assertion for the wrong
 * reason. So this collects all three.
 */

/** Every string and bound value in a drizzle SQL tree, in order. Owner scoping
 *  shows up here as the owner id among a WHERE's values. */
export function sqlValues(value: unknown, out: unknown[] = []): unknown[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) sqlValues(v, out);
    return out;
  }
  const o = value as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) sqlValues(c, out);
  else if (Array.isArray(o.value)) for (const v of o.value) sqlValues(v, out);
  else if ('value' in o) out.push(o.value);
  return out;
}
