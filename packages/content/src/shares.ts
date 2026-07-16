/**
 * Share-link CRUD. A share is a revocable token granting read-only public
 * access to one node. The owner toggles a link on/off; the public surface
 * resolves strictly by an *active* token. See docs/sharing.md.
 *
 * Token: 16 random bytes (128-bit) as base64url (~22 url-safe chars).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, nodes, shares, type Share } from '@mantle/db';

/** Node types that may be shared publicly. Sensitive types are excluded. */
export const SHAREABLE_TYPES = ['page', 'note', 'task', 'event', 'file', 'app'] as const;
export type ShareableType = (typeof SHAREABLE_TYPES)[number];

export function isShareable(type: string): type is ShareableType {
  return (SHAREABLE_TYPES as readonly string[]).includes(type);
}

/**
 * Who a share admits. Lives in `shares.settings.mode` (absent = 'public', so
 * every pre-existing share keeps its behavior).
 *
 *   public — anyone with the link (the original model).
 *   team   — the visitor must additionally present a live team credential
 *            (see @mantle/content/team-tokens). Enforced for every kind on
 *            the /s/ surface (page render, asset bytes, app brokers).
 *            Team-mode PAGE shares double as the /team hub's briefing
 *            sections (see ./team-hub).
 */
export type ShareMode = 'public' | 'team';

/** Read the mode off a raw share row (settings.mode, default public). */
export function shareModeOf(s: Pick<Share, 'settings'>): ShareMode {
  return (s.settings as Record<string, unknown>)?.mode === 'team' ? 'team' : 'public';
}

/** Whether a page share cascades to its subtree (settings.cascade, default
 *  false). When true, the page's descendant pages are shared to match this
 *  share's mode, and a mode change or un-share propagates to them. */
export function shareCascadeOf(s: Pick<Share, 'settings'>): boolean {
  return (s.settings as Record<string, unknown>)?.cascade === true;
}

export type ShareSummary = {
  id: string;
  token: string;
  nodeId: string;
  nodeType: string;
  mode: ShareMode;
  /** Subtree sharing on — this page's descendant pages are shared to match
   *  (see {@link setShareCascade}). Meaningful only on page shares. */
  cascade: boolean;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number;
};

function toSummary(s: Share): ShareSummary {
  return {
    id: s.id,
    token: s.token,
    nodeId: s.nodeId,
    nodeType: s.nodeType,
    mode: shareModeOf(s),
    cascade: shareCascadeOf(s),
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    viewCount: s.viewCount,
  };
}

/** Switch a share between public and team admission (owner-scoped). Merges
 *  into `settings` so other keys survive. Returns false when no such share. */
export async function setShareMode(
  ownerId: string,
  shareId: string,
  mode: ShareMode,
): Promise<boolean> {
  const rows = await db
    .update(shares)
    .set({ settings: sql`${shares.settings} || ${JSON.stringify({ mode })}::jsonb` })
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .returning({ id: shares.id });
  return rows.length > 0;
}

function genToken(): string {
  return randomBytes(16).toString('base64url');
}

/** The app's public origin, for building share URLs outside the web request
 *  cycle (e.g. the agent process, where there's no incoming request to read an
 *  origin from). `MANTLE_PUBLIC_URL` overrides; falls back to the same
 *  `NEXT_PUBLIC_APP_URL` the web app uses, then localhost. */
export function publicBaseUrl(): string {
  const raw = process.env.MANTLE_PUBLIC_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return raw.replace(/\/$/, '');
}

/** Public `/s/<token>` URL for a share token, using {@link publicBaseUrl}. */
export function shareUrlForToken(token: string): string {
  return `${publicBaseUrl()}/s/${token}`;
}

/** Canonical in-app permalink for any node, by id alone — `<origin>/n/<id>`.
 *  The `/n/[id]` route resolves the node's type and redirects to the right
 *  surface (note → /notes?selected, page → /pages/<id>, …), so callers never
 *  need to know the type. This is the link responders embed when they reference
 *  an item to the user (markdown `[title](url)`), and it stays correct even if a
 *  surface's URL shape changes. Absolute so it survives outside the web request
 *  cycle (Telegram, email) and same-origin in the app (the chat renderer routes
 *  same-origin links via the SPA router). */
export function nodeUrl(id: string): string {
  return `${publicBaseUrl()}/n/${id}`;
}

/** SQL predicate: a share row that is currently active (not revoked, not past
 *  its expiry). */
function activePredicate() {
  return and(isNull(shares.revokedAt), or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())));
}

/** The owner's active link for a node, or null. */
export async function getActiveShareForNode(
  ownerId: string,
  nodeId: string,
): Promise<ShareSummary | null> {
  const [row] = await db
    .select()
    .from(shares)
    .where(and(eq(shares.ownerId, ownerId), eq(shares.nodeId, nodeId), activePredicate()))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Create (or return the existing) active share for a node. Idempotent —
 * "one link per item": if an active link exists, it's returned unchanged.
 * Validates owner + shareable type.
 */
export async function createShare(ownerId: string, nodeId: string): Promise<ShareSummary> {
  const [node] = await db
    .select({ id: nodes.id, type: nodes.type })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!node) throw new Error('node not found');
  if (!isShareable(node.type)) throw new Error(`type '${node.type}' is not shareable`);

  const existing = await getActiveShareForNode(ownerId, nodeId);
  if (existing) return existing;

  const [row] = await db
    .insert(shares)
    .values({ ownerId, nodeId, nodeType: node.type, token: genToken() })
    .returning();
  if (!row) throw new Error('failed to create share');
  return toSummary(row);
}

/** Revoke a share by id (owner-scoped). Returns true if a row was revoked. */
export async function revokeShare(ownerId: string, shareId: string): Promise<boolean> {
  const rows = await db
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .returning({ id: shares.id });
  return rows.length > 0;
}

/** Resolve an active share by its public token. NOT owner-scoped — this is the
 *  public read path. Returns the full row (caller decides what to expose). */
export async function resolveActiveShareByToken(token: string): Promise<Share | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(shares)
    .where(and(eq(shares.token, token), activePredicate()))
    .limit(1);
  return row ?? null;
}

/** Best-effort view counter bump for a token (fire-and-forget by callers). */
export async function recordShareView(shareId: string): Promise<void> {
  await db
    .update(shares)
    .set({ viewCount: sql`${shares.viewCount} + 1`, lastViewedAt: new Date() })
    .where(eq(shares.id, shareId));
}

// ─── Subtree ("Share children") ──────────────────────────────────────────────
// A page share can cascade to its descendant pages: sharing the parent shares
// the whole subtree, and the children track the parent's admission mode. The
// intent lives in `settings.cascade` on the PARENT share; children are ordinary
// shares. Semantics (see docs/sharing.md): a SNAPSHOT — toggling on shares the
// pages that exist now (a page added later needs a re-toggle) — and cascade-off:
// turning it off, or un-sharing the parent, revokes the child links too.

/** All descendant PAGE ids under a page (children, grandchildren, …) via the
 *  parent_id tree. `UNION` (not UNION ALL) is cycle-safe. Mirrors
 *  {@link countPageDescendants}. */
export async function listPageDescendantIds(ownerId: string, parentId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT id FROM ${nodes}
       WHERE parent_id = ${parentId} AND owner_id = ${ownerId} AND type = 'page'
      UNION
      SELECT n.id FROM ${nodes} n
        JOIN descendants d ON n.parent_id = d.id
       WHERE n.owner_id = ${ownerId} AND n.type = 'page'
    )
    SELECT id FROM descendants
  `);
  const rows = (
    Array.isArray(result) ? result : (result as { rows?: Array<{ id: string }> }).rows ?? []
  ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Turn subtree sharing on/off for a page (the "Share sub-pages" switch). Flips
 * `settings.cascade` on the parent's active share, then:
 *   on  — shares every descendant page (idempotent) at the parent's current mode.
 *   off — revokes every descendant page's active share.
 * No-op (ok:false) if the parent isn't currently shared. Returns how many
 * descendant shares were created/updated (on) or revoked (off).
 */
export async function setShareCascade(
  ownerId: string,
  parentNodeId: string,
  on: boolean,
): Promise<{ ok: boolean; count: number }> {
  const parent = await getActiveShareForNode(ownerId, parentNodeId);
  if (!parent) return { ok: false, count: 0 };

  await db
    .update(shares)
    .set({ settings: sql`${shares.settings} || ${JSON.stringify({ cascade: on })}::jsonb` })
    .where(and(eq(shares.id, parent.id), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)));

  const ids = await listPageDescendantIds(ownerId, parentNodeId);
  if (ids.length === 0) return { ok: true, count: 0 };

  if (on) {
    for (const id of ids) {
      const child = await createShare(ownerId, id); // idempotent — returns existing
      if (child.mode !== parent.mode) await setShareMode(ownerId, child.id, parent.mode);
    }
    return { ok: true, count: ids.length };
  }

  const revoked = await db
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(and(eq(shares.ownerId, ownerId), inArray(shares.nodeId, ids), isNull(shares.revokedAt)))
    .returning({ id: shares.id });
  return { ok: true, count: revoked.length };
}

/** Set a share's mode, propagating to the subtree when the share cascades.
 *  Drop-in for {@link setShareMode} on the owner PATCH path. Returns false when
 *  no such active share. */
export async function applyShareMode(
  ownerId: string,
  shareId: string,
  mode: ShareMode,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .limit(1);
  if (!row) return false;

  const ok = await setShareMode(ownerId, shareId, mode);
  if (!ok) return false;

  if (shareCascadeOf(row)) {
    const ids = await listPageDescendantIds(ownerId, row.nodeId);
    if (ids.length > 0) {
      await db
        .update(shares)
        .set({ settings: sql`${shares.settings} || ${JSON.stringify({ mode })}::jsonb` })
        .where(
          and(eq(shares.ownerId, ownerId), inArray(shares.nodeId, ids), isNull(shares.revokedAt)),
        );
    }
  }
  return true;
}

/** Revoke a share, cascading to the subtree when it cascades. Drop-in for
 *  {@link revokeShare} on the owner DELETE path. */
export async function revokeShareTree(ownerId: string, shareId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .limit(1);
  if (!row) return revokeShare(ownerId, shareId); // already gone / not found — idempotent

  if (shareCascadeOf(row)) {
    const ids = await listPageDescendantIds(ownerId, row.nodeId);
    if (ids.length > 0) {
      await db
        .update(shares)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(shares.ownerId, ownerId), inArray(shares.nodeId, ids), isNull(shares.revokedAt)),
        );
    }
  }
  return revokeShare(ownerId, shareId);
}
