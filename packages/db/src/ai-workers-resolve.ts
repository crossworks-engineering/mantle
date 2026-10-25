/**
 * Resolution helpers for ai_workers. Lives in @mantle/db so both
 * `server/web` (UI/CRUD) and `server/api` (runtime workers) can call
 * them — neither needs the other's package.
 *
 * Pick the right worker for a (owner, kind), or one job's own worker by
 * slug, and bump telemetry after it runs. Everything else (create/update/delete)
 * lives in server/web/lib/ai-workers.ts since only the UI needs it.
 */

import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { db } from './client';
import { aiWorkers, type AiWorker, type AiWorkerKind } from './schema/ai-workers';

/**
 * Workers the manifest ships for ONE job, beside the default of their kind:
 * `drawing-check`, a dearer vision model the image check of a drawing asks
 * (circuit_verify). Never a kind's default, and never picked as its
 * fallback below: indexing every image on it would spend far more than the
 * owner chose.
 */
export const DEDICATED_WORKER_SLUGS: readonly string[] = ['drawing-check'];

/**
 * Returns the worker the runtime should use for the given owner+kind.
 * Resolution order:
 *   1. Enabled row with is_default=true → use it.
 *   2. Otherwise highest-priority enabled row of that kind, never a
 *      dedicated one (DEDICATED_WORKER_SLUGS).
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
      and(
        eq(aiWorkers.ownerId, ownerId),
        eq(aiWorkers.kind, kind),
        eq(aiWorkers.enabled, true),
        notInArray(aiWorkers.slug, [...DEDICATED_WORKER_SLUGS]),
      ),
    )
    .orderBy(desc(aiWorkers.priority), desc(aiWorkers.updatedAt))
    .limit(1);
  return fallback ?? null;
}

/**
 * One job's own worker: the enabled `kind` row with this `slug`, else the
 * kind's default (getDefaultWorker) with `fellBack` set, so the caller can
 * say which model answered. Null when neither is there.
 */
export async function getWorkerBySlug(
  ownerId: string,
  kind: AiWorkerKind,
  slug: string,
): Promise<{ worker: AiWorker; fellBack: boolean } | null> {
  const [own] = await db
    .select()
    .from(aiWorkers)
    .where(
      and(
        eq(aiWorkers.ownerId, ownerId),
        eq(aiWorkers.kind, kind),
        eq(aiWorkers.slug, slug),
        eq(aiWorkers.enabled, true),
      ),
    )
    .limit(1);
  if (own) return { worker: own, fellBack: false };
  const def = await getDefaultWorker(ownerId, kind);
  return def ? { worker: def, fellBack: true } : null;
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
