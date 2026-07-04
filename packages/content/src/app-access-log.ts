/**
 * Audit writes for the external app-share surface. Every visitor action on
 * /s/<token>/* lands one row: WHO (contactId, or null for an anonymous
 * public-mode visitor), WHAT (kind + detail), on WHICH app. This is the
 * "the app registers who it's for" half of the team-token design — the token
 * carries identity, this table remembers it.
 *
 * Fire-and-forget by design: `recordAppAccess` swallows failures so an audit
 * hiccup can never take down a working app for a visitor. It must stay a
 * best-effort trail, not a gate.
 */
import { desc, eq } from 'drizzle-orm';
import { db, appAccessLog } from '@mantle/db';

export type AppAccessKind = 'auth' | 'tool' | 'db';

export type AppAccessEntry = {
  ownerId: string;
  appNodeId: string;
  shareId?: string | null;
  contactId?: string | null;
  kind: AppAccessKind;
  detail?: Record<string, unknown>;
};

export function recordAppAccess(entry: AppAccessEntry): void {
  void db
    .insert(appAccessLog)
    .values({
      ownerId: entry.ownerId,
      appNodeId: entry.appNodeId,
      shareId: entry.shareId ?? null,
      contactId: entry.contactId ?? null,
      kind: entry.kind,
      detail: entry.detail ?? {},
    })
    .catch(() => {
      /* best-effort — never block the visitor on audit */
    });
}

export type AppAccessRow = {
  id: string;
  contactId: string | null;
  kind: AppAccessKind;
  detail: Record<string, unknown>;
  createdAt: string;
};

/** Recent external activity for one app, newest first (operator surfaces). */
export async function listAppAccess(
  ownerId: string,
  appNodeId: string,
  limit = 100,
): Promise<AppAccessRow[]> {
  const rows = await db
    .select()
    .from(appAccessLog)
    .where(eq(appAccessLog.appNodeId, appNodeId))
    .orderBy(desc(appAccessLog.createdAt))
    .limit(limit);
  return rows
    .filter((r) => r.ownerId === ownerId)
    .map((r) => ({
      id: r.id,
      contactId: r.contactId,
      kind: r.kind as AppAccessKind,
      detail: r.detail,
      createdAt: r.createdAt.toISOString(),
    }));
}
