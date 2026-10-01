/**
 * Tool-row lookups by slug. Pulled out of dispatch.ts on 2026-09-02 (audit,
 * complexity C6): the app/run builtins need only these, and importing them
 * from dispatch.ts dragged in the registry and closed the cycle
 * registry → builtins → builtins-{apps,runs} → dispatch → registry.
 */
import { and, eq } from 'drizzle-orm';
import { db, tools, type Tool } from '@mantle/db';

/** Look up a tool by slug for a given owner. Returns null if missing/disabled. */
export async function resolveTool(ownerId: string, slug: string): Promise<Tool | null> {
  const [row] = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, slug), eq(tools.enabled, true)))
    .limit(1);
  return row ?? null;
}

/** Resolve a batch of slugs at once. Skips missing/disabled silently.
 *  Returned in the order of `slugs`, not row order: the tool list is the
 *  front of every cached prompt prefix, and Postgres row order is not
 *  stable (every boot rewrites the builtin rows), so row order made the
 *  prompt cache miss for no reason. */
export async function resolveTools(ownerId: string, slugs: string[]): Promise<Tool[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.enabled, true)));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  return [...new Set(slugs)].flatMap((s) => {
    const row = bySlug.get(s);
    return row ? [row] : [];
  });
}
