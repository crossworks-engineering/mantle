/**
 * The provider-alert store (migration 0230, docs/embeddings.md "Provider
 * outages"). One row per brain and subject: the open embedding or extraction
 * failure, if any. Lives in @mantle/db so the embedder (@mantle/embeddings),
 * the extract queue (server/api) and the admin reads (@mantle/content,
 * server/web) share one set of rules.
 *
 * Every write goes through `systemDb`: an embed under a limited viewer (a
 * member's chat turn) still records the outage. Callers throttle their writes
 * (one per subject per minute), so a burst of failing jobs is a handful of
 * row updates, not one per call.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { systemDb } from './client';
import { providerAlerts, type ProviderAlertRow } from './schema/provider-alerts';

export type ProviderSubject = 'embedding' | 'extraction';
export const PROVIDER_SUBJECTS: readonly ProviderSubject[] = ['embedding', 'extraction'];

/** A transient failure (rate limit, 5xx, network) is shown only once it has
 *  lasted this long: a blip that retries fix never reaches an admin. */
export const PROVIDER_ALERT_VISIBLE_AFTER_MS = 10 * 60_000;

export interface ProviderFailure {
  code: string;
  permanent: boolean;
  /** Fixed text (PROVIDER_ERROR_REASONS), never provider text. */
  reason: string;
  provider?: string | null;
  model?: string | null;
}

export type { ProviderAlertRow };

/**
 * Record one failure. Opens the row (or starts a resolved one over) or adds
 * to the open one. An open PERMANENT reason is kept when a transient error
 * follows it: a network blip during a no-credits outage must not hide the
 * reason an admin has to act on.
 */
export async function recordProviderFailure(
  ownerId: string,
  subject: ProviderSubject,
  f: ProviderFailure,
  now: Date = new Date(),
): Promise<ProviderAlertRow | null> {
  const visibleCutoff = new Date(now.getTime() - PROVIDER_ALERT_VISIBLE_AFTER_MS);
  const open = sql`${providerAlerts.resolvedAt} IS NULL`;
  const keepOld = sql`(${open} AND ${providerAlerts.permanent} AND NOT excluded.permanent)`;
  const [row] = await systemDb
    .insert(providerAlerts)
    .values({
      ownerId,
      subject,
      code: f.code,
      permanent: f.permanent,
      reason: f.reason,
      provider: f.provider ?? null,
      model: f.model ?? null,
      failingSince: now,
      lastErrorAt: now,
      errorCount: 1,
      visible: f.permanent,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [providerAlerts.ownerId, providerAlerts.subject],
      set: {
        code: sql`CASE WHEN ${keepOld} THEN ${providerAlerts.code} ELSE excluded.code END`,
        reason: sql`CASE WHEN ${keepOld} THEN ${providerAlerts.reason} ELSE excluded.reason END`,
        provider: sql`CASE WHEN ${keepOld} THEN ${providerAlerts.provider} ELSE excluded.provider END`,
        model: sql`CASE WHEN ${keepOld} THEN ${providerAlerts.model} ELSE excluded.model END`,
        permanent: sql`${keepOld} OR excluded.permanent`,
        failingSince: sql`CASE WHEN ${open} THEN ${providerAlerts.failingSince} ELSE excluded.failing_since END`,
        errorCount: sql`CASE WHEN ${open} THEN ${providerAlerts.errorCount} + 1 ELSE 1 END`,
        paused: sql`CASE WHEN ${open} THEN ${providerAlerts.paused} ELSE false END`,
        nextProbeAt: sql`CASE WHEN ${open} THEN ${providerAlerts.nextProbeAt} ELSE NULL END`,
        probeAttempts: sql`CASE WHEN ${open} THEN ${providerAlerts.probeAttempts} ELSE 0 END`,
        lastProbeAt: sql`CASE WHEN ${open} THEN ${providerAlerts.lastProbeAt} ELSE NULL END`,
        visible: sql`${keepOld} OR excluded.permanent
          OR (${open} AND ${providerAlerts.failingSince} <= ${visibleCutoff.toISOString()}::timestamptz)`,
        lastErrorAt: sql`excluded.last_error_at`,
        resolvedAt: sql`NULL`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning();
  return row ?? null;
}

/** A call worked: close the open alert. True when this closed one. */
export async function resolveProviderAlert(
  ownerId: string,
  subject: ProviderSubject,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await systemDb
    .update(providerAlerts)
    .set({ resolvedAt: now, paused: false, nextProbeAt: null, updatedAt: now })
    .where(
      and(
        eq(providerAlerts.ownerId, ownerId),
        eq(providerAlerts.subject, subject),
        isNull(providerAlerts.resolvedAt),
      ),
    )
    .returning({ subject: providerAlerts.subject });
  return rows.length > 0;
}

/** The extract queue paused (or resumed) for this open alert, and when to
 *  probe next. Pausing also shows it: the queue only pauses for a confirmed
 *  permanent error. */
export async function setProviderAlertPaused(
  ownerId: string,
  subject: ProviderSubject,
  paused: boolean,
  nextProbeAt: Date | null,
  now: Date = new Date(),
): Promise<void> {
  await systemDb
    .update(providerAlerts)
    .set({ paused, nextProbeAt, updatedAt: now, ...(paused ? { visible: true } : {}) })
    .where(
      and(
        eq(providerAlerts.ownerId, ownerId),
        eq(providerAlerts.subject, subject),
        isNull(providerAlerts.resolvedAt),
      ),
    );
}

/** A probe failed: count it and set the next one. */
export async function recordProviderProbeFailure(
  ownerId: string,
  subject: ProviderSubject,
  nextProbeAt: Date,
  now: Date = new Date(),
): Promise<void> {
  await systemDb
    .update(providerAlerts)
    .set({
      probeAttempts: sql`${providerAlerts.probeAttempts} + 1`,
      lastProbeAt: now,
      nextProbeAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerAlerts.ownerId, ownerId),
        eq(providerAlerts.subject, subject),
        isNull(providerAlerts.resolvedAt),
      ),
    );
}

/** An admin's "Try again": every open alert probes on the agent's next tick
 *  (within 30 s). Returns how many rows it touched. */
export async function requestProviderProbeNow(
  ownerId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await systemDb
    .update(providerAlerts)
    .set({ nextProbeAt: now, updatedAt: now })
    .where(and(eq(providerAlerts.ownerId, ownerId), isNull(providerAlerts.resolvedAt)))
    .returning({ subject: providerAlerts.subject });
  return rows.length;
}

/** Every alert row of the brain, open or resolved. */
export async function listProviderAlerts(ownerId: string): Promise<ProviderAlertRow[]> {
  return systemDb.select().from(providerAlerts).where(eq(providerAlerts.ownerId, ownerId));
}

/** The open alerts. */
export async function listOpenProviderAlerts(ownerId: string): Promise<ProviderAlertRow[]> {
  return systemDb
    .select()
    .from(providerAlerts)
    .where(and(eq(providerAlerts.ownerId, ownerId), isNull(providerAlerts.resolvedAt)));
}

/** What an admin sees: open and visible. */
export function isAlertShown(row: Pick<ProviderAlertRow, 'visible' | 'resolvedAt'>): boolean {
  return row.visible && row.resolvedAt === null;
}

/**
 * Extract jobs that wait for the provider: queued, retrying, running and
 * dead-lettered. Null when pg-boss has no schema yet (a fresh brain before
 * the agent first started).
 */
export async function countExtractBacklog(): Promise<number | null> {
  try {
    const rows = (await systemDb.execute(sql`
      SELECT count(*)::int AS n FROM pgboss.job
      WHERE (name = 'mantle.extract' AND state IN ('created', 'retry', 'active'))
         OR (name = 'mantle.extract.dead' AND state = 'created')`)) as unknown as Array<{
      n: number;
    }>;
    return rows[0]?.n ?? 0;
  } catch {
    return null;
  }
}

/** Jobs in the extract dead-letter queue: whether a config change has a
 *  backlog to recover. 0 when pg-boss has no schema yet. */
export async function countDeadLetteredExtracts(): Promise<number> {
  try {
    const rows = (await systemDb.execute(sql`
      SELECT count(*)::int AS n FROM pgboss.job
      WHERE name = 'mantle.extract.dead' AND state = 'created'`)) as unknown as Array<{
      n: number;
    }>;
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}
