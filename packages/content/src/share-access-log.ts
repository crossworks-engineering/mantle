/**
 * The contact share audit trail (migration 0214): what a contact did on a
 * contact share. One row per asset, write and refusal; an open, a
 * database read and a gate 401 (no admitting cookie) land at most one row
 * per share a minute (an app polls, a reader reloads). Failed codes are written by the code check itself
 * (contact-share-codes.ts), in its transaction.
 *
 * Fire-and-forget, like the app access log: an audit hiccup never blocks a
 * visitor. Reaped after {@link SHARE_ACCESS_LOG_RETENTION_DAYS} by the
 * `app-access-log-reap` maintenance sweep.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { shareAccessLog, systemDb, type ShareAccessKind } from '@mantle/db';

export type { ShareAccessKind };

export type ShareAccessEntry = {
  ownerId: string;
  shareId: string;
  contactId: string | null;
  kind: ShareAccessKind;
  detail?: Record<string, unknown>;
  /** Sample this row like an open (at most one per share a minute): a gate
   *  401 on a contact share, which an app or a reload can repeat fast. */
  sampled?: boolean;
};

/** Opens and reads land at most one row per share this often. */
export const SHARE_ACCESS_SAMPLE_MS = 60_000;
/** The trail keeps this many days. */
export const SHARE_ACCESS_LOG_RETENTION_DAYS = 90;

const lastSampled = new Map<string, number>();

function sampledAway(entry: ShareAccessEntry, now: number): boolean {
  if (entry.kind !== 'open' && entry.kind !== 'query' && !entry.sampled) return false;
  const key = `${entry.kind}${entry.sampled ? ':sampled' : ''}:${entry.shareId}`;
  const last = lastSampled.get(key);
  if (last !== undefined && now - last < SHARE_ACCESS_SAMPLE_MS) return true;
  if (lastSampled.size >= 10_000) {
    for (const [k, t] of lastSampled) {
      if (now - t >= SHARE_ACCESS_SAMPLE_MS) lastSampled.delete(k);
    }
  }
  lastSampled.set(key, now);
  return false;
}

export function recordShareAccess(entry: ShareAccessEntry): void {
  if (sampledAway(entry, Date.now())) return;
  void systemDb
    .insert(shareAccessLog)
    .values({
      ownerId: entry.ownerId,
      shareId: entry.shareId,
      contactId: entry.contactId,
      kind: entry.kind,
      detail: entry.detail ?? {},
    })
    .catch(() => {
      /* best-effort: never block the visitor on audit */
    });
}

export type ShareAccessRow = {
  id: string;
  kind: ShareAccessKind;
  detail: Record<string, unknown>;
  createdAt: string;
};

/** A share's newest trail rows (owner-scoped). */
export async function listShareAccess(
  ownerId: string,
  shareId: string,
  limit = 100,
): Promise<ShareAccessRow[]> {
  const rows = await systemDb
    .select({
      id: shareAccessLog.id,
      kind: shareAccessLog.kind,
      detail: shareAccessLog.detail,
      createdAt: shareAccessLog.createdAt,
    })
    .from(shareAccessLog)
    .where(and(eq(shareAccessLog.ownerId, ownerId), eq(shareAccessLog.shareId, shareId)))
    .orderBy(desc(shareAccessLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * The reaper (part of the `app-access-log-reap` sweep, plain SQL, no
 * model): deletes trail rows older than the retention, in batches.
 * `dryRun` counts without deleting. Idempotent.
 */
export async function reapShareAccessLog(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - SHARE_ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  if (opts.dryRun) {
    const [row] = await systemDb
      .select({ n: sql<number>`count(*)::int` })
      .from(shareAccessLog)
      .where(lt(shareAccessLog.createdAt, cutoff));
    return { deleted: row?.n ?? 0 };
  }
  const BATCH = 10_000;
  let deleted = 0;
  for (;;) {
    const gone = (await systemDb.execute(sql`
      delete from share_access_log
       where id in (select id from share_access_log where created_at < ${cutoff.toISOString()}::timestamptz limit ${BATCH})
      returning id`)) as unknown as unknown[];
    deleted += gone.length;
    if (gone.length < BATCH) return { deleted };
  }
}
