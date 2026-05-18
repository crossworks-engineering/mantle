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

export async function seedBuiltinTools(ownerId: string): Promise<{
  inserted: number;
  updated: number;
}> {
  let inserted = 0;
  let updated = 0;
  const defs = listBuiltins();
  for (const def of defs) {
    const handler: ToolHandler = { kind: 'builtin', ref: def.slug };
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
        inputSchema: def.inputSchema,
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
          inputSchema: def.inputSchema,
          handler,
          updatedAt: new Date(),
        })
        .where(eq(tools.id, existing[0]!.id));
      updated++;
    }
  }
  return { inserted, updated };
}
