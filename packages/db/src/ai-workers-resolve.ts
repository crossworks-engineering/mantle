/**
 * Resolution helpers for ai_workers. Lives in @mantle/db so both
 * `apps/web` (UI/CRUD) and `apps/agent` (runtime workers) can call
 * them — neither needs the other's package.
 *
 * Just two functions: pick the right worker for a (owner, kind), and
 * bump telemetry after it runs. Everything else (create/update/delete)
 * lives in apps/web/lib/ai-workers.ts since only the UI needs it.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from './client';
import { aiWorkers, type AiWorker, type AiWorkerKind } from './schema/ai-workers';

/**
 * Returns the worker the runtime should use for the given owner+kind.
 * Resolution order:
 *   1. Enabled row with is_default=true → use it.
 *   2. Otherwise highest-priority enabled row of that kind.
 *   3. Otherwise null. Caller decides whether that's fatal.
 */
export async function getDefaultWorker(
  ownerId: string,
  kind: AiWorkerKind,
): Promise<AiWorker | null> {
  const [explicit] = await db
    .select()
    .from(aiWorkers)
    .where(
      and(
        eq(aiWorkers.ownerId, ownerId),
        eq(aiWorkers.kind, kind),
        eq(aiWorkers.enabled, true),
        eq(aiWorkers.isDefault, true),
      ),
    )
    .limit(1);
  if (explicit) return explicit;
  const [fallback] = await db
    .select()
    .from(aiWorkers)
    .where(
      and(eq(aiWorkers.ownerId, ownerId), eq(aiWorkers.kind, kind), eq(aiWorkers.enabled, true)),
    )
    .orderBy(desc(aiWorkers.priority), desc(aiWorkers.updatedAt))
    .limit(1);
  return fallback ?? null;
}

/**
 * Resolve the TTS worker an AGENT should speak with. An agent may pin a
 * `kind='tts'` worker (agents.tts_worker_id); if it does and that worker is
 * still owned + enabled, use it. Otherwise — unset, deleted, disabled, or wrong
 * kind — fall back to the owner's default TTS worker, exactly as before. So a
 * pinned-but-disabled worker degrades gracefully rather than going silent.
 */
export async function getAgentTtsWorker(
  ownerId: string,
  ttsWorkerId: string | null | undefined,
): Promise<AiWorker | null> {
  if (ttsWorkerId) {
    const [pinned] = await db
      .select()
      .from(aiWorkers)
      .where(
        and(
          eq(aiWorkers.id, ttsWorkerId),
          eq(aiWorkers.ownerId, ownerId),
          eq(aiWorkers.kind, 'tts'),
          eq(aiWorkers.enabled, true),
        ),
      )
      .limit(1);
    if (pinned) return pinned;
  }
  return getDefaultWorker(ownerId, 'tts');
}

/** Best-effort usage telemetry bump. Never throws — workers should
 *  succeed even if the bump fails. */
export async function bumpWorkerUsage(id: string): Promise<void> {
  await db
    .update(aiWorkers)
    .set({
      lastUsedAt: new Date(),
      usageCount: sql`${aiWorkers.usageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(aiWorkers.id, id))
    .catch(() => {});
}
