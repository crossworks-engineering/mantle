/**
 * Idempotent seed: upsert every built-in tool definition into the
 * `tools` table for the given owner. Runs at agent boot — registry
 * changes (new tools, edits to existing) propagate next restart.
 *
 * Doesn't touch user-defined HTTP / shell tools; only operates on rows
 * whose `handler.kind = 'builtin'`.
 */

import { and, eq } from 'drizzle-orm';
import { db, tools, type ToolHandler } from '@mantle/db';
import { listBuiltins } from './registry';

/**
 * Close a builtin's top-level schema: `additionalProperties: false` unless the
 * def already took a position. Audited 2026-07-07: every builtin's TOP-level
 * keys are fixed — dynamic-key inputs (table cells, app source files) all live
 * one level down in nested object props that declare their own
 * `additionalProperties` — so closing the top level is universally correct.
 *
 * Two consumers act on the closed schema:
 *   · the model sees it (schemas ship verbatim via buildToolsForModel), which
 *    alone reduces invented parameters on schema-respecting providers;
 *   · the central validator (validate-args.ts) treats a closed schema's
 *    unknown keys as violations — 'limt' → teaching error naming 'limit' —
 *    instead of telemetry-only.
 *
 * A future builtin that genuinely wants dynamic top-level keys opts out by
 * setting `additionalProperties: true` in its own inputSchema literal.
 * User-authored tools (http/recipe rows) are untouched — theirs stay open
 * unless the author closes them.
 */
export function closeToolInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== 'object') return schema;
  if ('additionalProperties' in schema) return schema;
  const props = schema.properties;
  const hasProps = props !== null && typeof props === 'object' && Object.keys(props).length > 0;
  if (!hasProps) return schema; // zero-arg tools: nothing to protect
  return { ...schema, additionalProperties: false };
}

export async function seedBuiltinTools(ownerId: string): Promise<{
  inserted: number;
  updated: number;
}> {
  let inserted = 0;
  let updated = 0;
  const defs = listBuiltins();
  for (const def of defs) {
    const handler: ToolHandler = { kind: 'builtin', ref: def.slug };
    const inputSchema = closeToolInputSchema(def.inputSchema);
    const existing = await db
      .select({ id: tools.id })
      .from(tools)
      .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, def.slug)))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(tools).values({
        ownerId,
        slug: def.slug,
        name: def.name,
        description: def.description,
        inputSchema,
        handler,
        requiresConfirm: def.requiresConfirm ?? false,
        enabled: true,
      });
      inserted++;
    } else {
      // Refresh metadata so registry edits propagate.
      await db
        .update(tools)
        .set({
          name: def.name,
          description: def.description,
          inputSchema,
          handler,
          updatedAt: new Date(),
        })
        .where(eq(tools.id, existing[0]!.id));
      updated++;
    }
  }
  return { inserted, updated };
}
