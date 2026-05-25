/**
 * Resolution/telemetry helpers for the `agents` table. Lives in
 * @mantle/db so both `apps/web` (UI/CRUD) and the runtime
 * (`@mantle/agent-runtime`, `apps/agent`) can call them.
 *
 * The sibling `ai-workers-resolve.ts` does the same job for the
 * `ai_workers` table; agents (responder + delegation targets like
 * `researcher`/`remy`) need their own bump.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from './client';
import { agents } from './schema/agents';

/**
 * Best-effort usage telemetry bump for an `agents` row. Race-safe
 * (SQL increment, not read-modify-write) and never throws — a turn or
 * delegation should succeed even if the bump fails.
 *
 * Mirrors `bumpWorkerUsage`. Bumps only `last_used_at` + `usage_count`
 * to match the existing responder bump sites (assistant.ts / main.ts),
 * which deliberately leave `updated_at` untouched.
 */
export async function bumpAgentUsage(id: string): Promise<void> {
  await db
    .update(agents)
    .set({
      lastUsedAt: new Date(),
      usageCount: sql`${agents.usageCount} + 1`,
    })
    .where(eq(agents.id, id))
    .catch(() => {});
}
