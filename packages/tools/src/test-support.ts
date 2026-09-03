/**
 * Shared helpers for the handler tests. NOT a test file (no `.test.ts`), so
 * vitest does not collect it.
 *
 * Why this exists: a db mock whose `where` is `vi.fn().mockReturnThis()`
 * accepts any clause and asserts nothing, so deleting the owner-id term from a
 * handler leaves every test green. The 2026-09-03 audit-of-audit mutated six
 * such handlers and all six survived. Capture the clause instead and walk its
 * bound params.
 */

/** Bound parameter values of a drizzle SQL tree, in order. `eq(col, 'x')`
 *  contributes 'x'; `and(a, b)` nests. Owner scoping shows up here as the
 *  owner id being one of the params of the lookup. */
export function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const o = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if (Array.isArray(o.queryChunks)) for (const c of o.queryChunks) paramsOf(c, out);
  else if ('value' in o && 'encoder' in o) out.push(o.value);
  return out;
}
