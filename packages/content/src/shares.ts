/**
 * Share-link CRUD. A share is a revocable token granting read-only public
 * access to one node. The owner toggles a link on/off; the public surface
 * resolves strictly by an *active* token. See docs/sharing.md.
 *
 * Token: 16 random bytes (128-bit) as base64url (~22 url-safe chars).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, nodes, shares, type Share } from '@mantle/db';

/** Node types that may be shared publicly. Sensitive types are excluded. */
export const SHAREABLE_TYPES = ['page', 'note', 'task', 'event', 'file'] as const;
export type ShareableType = (typeof SHAREABLE_TYPES)[number];

export function isShareable(type: string): type is ShareableType {
  return (SHAREABLE_TYPES as readonly string[]).includes(type);
}

export type ShareSummary = {
  id: string;
  token: string;
  nodeId: string;
  nodeType: string;
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
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    viewCount: s.viewCount,
  };
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
