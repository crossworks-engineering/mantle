/**
 * Share-link CRUD. A share is a revocable token granting read-only public
 * access to one node, plus the items its served list holds
 * (`settings.served`, workspaces plan 8.1, migration 0262): a link is an
 * open door for people with no login, never a grant, and it never changes a
 * level or a grant. Who may open or close one, and what may go on its list,
 * is link-serve.ts. The public surface resolves strictly by an *active*
 * token. See docs/sharing.md.
 *
 * Token: 16 random bytes (128-bit) as base64url (~22 url-safe chars).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  bestEffortWrite,
  db,
  isSnapshotCopy,
  nodes,
  runReadPathWrite,
  shares,
  SNAPSHOT_COPY_NO_SHARE,
  type Share,
  type ViewerLevel,
} from '@mantle/db';
import type { ShareMode } from '@mantle/client-types';
import { kindSpecOf, kindsWhere, type PublicLinkKind } from '@mantle/client-types/kinds';
import { env } from '@mantle/config';

export type { ShareMode };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Where a share read or write runs: the pool, or a caller's transaction.
 *  Every function below that takes one runs ALL its reads and writes
 *  through it: a write on the pool while the caller's transaction holds the
 *  row would wait on itself. */
export type ShareDb = typeof db | Tx;

/** Node types that may be shared publicly: the kind registry's
 *  `publicLink` (@mantle/client-types/kinds). Sensitive types are excluded.
 *  A formula's link is a live calculator; a drawing's serves its COMMITTED
 *  SVG snapshot (validated by acceptSceneSvg at commit), never the scene or
 *  the draft. `branch` ('files-folder') = a FILES FOLDER only: a folder link
 *  serves the files and subfolders under it that are on its served list (see
 *  {@link isShareableFolderPath} and docs/sharing.md §folders). Branches
 *  outside the files tree (and the files root itself) are rejected at
 *  {@link createShare}. */
export const SHAREABLE_TYPES = kindsWhere<PublicLinkKind>((s) => s.publicLink !== false);
export type ShareableType = (typeof SHAREABLE_TYPES)[number];

export function isShareable(type: string): type is ShareableType {
  return (SHAREABLE_TYPES as readonly string[]).includes(type);
}

/** A `branch` node is shareable only when it's a folder strictly under the
 *  `files` root. The root itself is deliberately not shareable — "share my
 *  entire filesystem" should never be one accidental toggle. */
export function isShareableFolderPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith('files.');
}

/** Whether this node can carry a link at all: a shareable type, and a folder
 *  only under `files`. The same checks {@link createShare} throws on. */
export function canShareNode(node: { type: string; path: string | null }): boolean {
  const link = kindSpecOf(node.type)?.publicLink ?? false;
  return link === true || (link === 'files-folder' && isShareableFolderPath(node.path));
}

// ─── Links and levels ────────────────────────────────────────────────────────
// Since workspaces W5b2 a link neither follows nor sets a level: the levels
// are frozen (migration 0261) and grants decide who reads an item. An open
// link serves its item and its served list (0262). Team links stay retired
// (member logins Phase 6 stage 6: nothing makes one, TeamLinkRetiredError).
// The old client links were retired by 0192 and 0262 and are marked
// `settings.retired = 'client'`; /s still tells their visitors to sign in.

/** The link the old level path (`setItemLevel`) asks for: an open one at
 *  public, none above. */
export function shareModeForLevel(level: ViewerLevel): ShareMode | null {
  return level === 'public' ? 'public' : null;
}

/** Thrown when a caller asks for a team-mode link. Team links are retired
 *  (member logins Phase 6 stage 6): members use their own logins. */
export class TeamLinkRetiredError extends Error {
  readonly reason = 'team-links-retired';
  constructor() {
    super(
      'Team links are retired: members sign in with their own logins now. ' +
        "To show an item to members, grant it to their workspace in the item's Grant Access panel.",
    );
    this.name = 'TeamLinkRetiredError';
  }
}

/** Refuse any link mode but public (an untyped caller may still pass 'team'). */
function assertLinkMode(mode: string | undefined): void {
  if (mode !== undefined && mode !== 'public') throw new TeamLinkRetiredError();
}

/** A request for a link the item cannot carry (missing, a kind that is not
 *  shareable, a folder outside `files`). The message names nothing hidden
 *  and is safe to show. */
export class ShareInputError extends Error {
  constructor(
    readonly reason: 'not-found' | 'not-shareable',
    message: string,
  ) {
    super(message);
    this.name = 'ShareInputError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The served list a share's settings hold: lower-case node ids, in order,
 *  no repeats. */
export function shareServedIds(settings: unknown): string[] {
  const raw = (settings as { served?: unknown } | null | undefined)?.served;
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) if (typeof v === 'string' && UUID_RE.test(v)) out.add(v.toLowerCase());
  return [...out];
}

/** Lower-case, de-duplicated uuids, in order; anything else dropped. */
function normalizeServed(ids: readonly string[]): string[] {
  return shareServedIds({ served: ids });
}

/**
 * Make a node's link match a level: revoke it below public, create it at
 * public. Returns the link left in place (null below public, or when the
 * node cannot carry one, e.g. a folder outside `files`). Only the old level
 * path (`setItemLevel`) calls this; it writes no level.
 */
export async function applyLevelToShare(
  ownerId: string,
  nodeId: string,
  level: ViewerLevel,
  q: ShareDb = db,
): Promise<ShareSummary | null> {
  const want = shareModeForLevel(level);
  const current = await getActiveShareForNode(ownerId, nodeId, q);
  if (want === null) {
    if (current) await revokeShareTree(ownerId, current.id, q);
    return null;
  }
  if (!current) {
    const [node] = await q
      .select({ type: nodes.type, path: nodes.path })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
      .limit(1);
    if (!node || !canShareNode(node)) return null;
    return createShare(ownerId, nodeId, {}, q);
  }
  return current;
}

export type ShareSummary = {
  id: string;
  token: string;
  nodeId: string;
  nodeType: string;
  mode: ShareMode;
  /** DEPRECATED (folder phase 7): a page link used to be able to share the
   *  page's sub-pages with it; pages do not nest any more, so this is always
   *  false. Kept on the wire for clients from before the pages tree. Share a
   *  set of pages by sharing their folder (docs/folder-tree.md). */
  cascade: boolean;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number;
  /** The contact a contact share is for (migration 0214); null on an open
   *  link. */
  contactId: string | null;
  /** A contact share of an app whose contact may write the app's data. */
  canWrite: boolean;
  /** What an open link serves besides its item (plan 8.1): node ids, lower
   *  case. Empty on a contact share (it serves what its item names). */
  served: string[];
};

function toSummary(s: Share): ShareSummary {
  return {
    id: s.id,
    token: s.token,
    nodeId: s.nodeId,
    nodeType: s.nodeType,
    mode: 'public',
    cascade: false,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    viewCount: s.viewCount,
    contactId: s.contactId ?? null,
    canWrite: s.canWrite === true,
    served: s.contactId ? [] : shareServedIds(s.settings),
  };
}

function genToken(): string {
  return randomBytes(16).toString('base64url');
}

let warnedNoPublicUrl = false;

/** The app's public origin, for building share URLs outside the web request
 *  cycle (e.g. the agent process, where there's no incoming request to read an
 *  origin from). `MANTLE_PUBLIC_URL` overrides; falls back to the same
 *  `NEXT_PUBLIC_APP_URL` the web app uses, then localhost.
 *
 *  THE FALLBACK IS PERMANENT WHERE IT LANDS. Most callers hand the result
 *  straight to a model — every tool result carries `url: nodeUrl(id)` — and the
 *  model writes those links into prose that is then STORED: forum answers,
 *  assistant messages, pages. Nothing re-resolves them later, so a brain that
 *  ran once without a public origin keeps `http://localhost:3000/n/<id>` in its
 *  content forever, pointing at a machine the reader does not have.
 *
 *  There is a boot warning and a sanity check for the unset case, but neither
 *  reaches the process that does the writing — the agent runtime is not the web
 *  server — so warn here too, once, where the wrong URL is actually minted. */
export function publicBaseUrl(): string {
  const configured = env('MANTLE_PUBLIC_URL');
  if (!configured && !warnedNoPublicUrl) {
    warnedNoPublicUrl = true;
    console.warn(
      '[shares] No MANTLE_PUBLIC_URL or NEXT_PUBLIC_APP_URL — building links against ' +
        'http://localhost:3000. These are written into STORED content (agent answers, ' +
        'share links, emails) and are never re-resolved, so they stay wrong after the ' +
        'variable is set. Set it before seeding or running turns.',
    );
  }
  const raw = configured ?? 'http://localhost:3000';
  return raw.replace(/\/$/, '');
}

/** Public `/s/<token>` URL for a share token, using {@link publicBaseUrl}. */
export function shareUrlForToken(token: string): string {
  return `${publicBaseUrl()}/s/${token}`;
}

/** Absolute app URL for a NON-node screen (settings, /pending, /traces/<id>).
 *  Node-backed items should use {@link nodeUrl} instead — /n/<id> survives a
 *  surface's URL shape changing; this helper is for screens with no node id. */
export function appUrl(path: string): string {
  return `${publicBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
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
 *  its expiry, and not a team link: 0176 revoked them all, and one that
 *  somehow stayed live is never served or counted). */
function activePredicate() {
  return and(
    isNull(shares.revokedAt),
    or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
    sql`coalesce(${shares.settings}->>'mode', 'public') <> 'team'`,
  );
}

/** SQL predicate: an active OPEN link (no contact). A contact share
 *  (migration 0214) is managed in contact-shares.ts. */
function openPredicate() {
  return and(activePredicate(), isNull(shares.contactId));
}

/** The owner's active OPEN link for a node, or null. Contact shares are
 *  never returned here (see contact-shares.ts). */
export async function getActiveShareForNode(
  ownerId: string,
  nodeId: string,
  q: ShareDb = db,
): Promise<ShareSummary | null> {
  const [row] = await q
    .select()
    .from(shares)
    .where(and(eq(shares.ownerId, ownerId), eq(shares.nodeId, nodeId), openPredicate()))
    .limit(1);
  return row ? toSummary(row) : null;
}

/** The owner's live share by id (an open link or a contact share), or null.
 *  Revoked shares are not returned; an expired one is (it can still be
 *  revoked). */
export async function getLiveShare(
  ownerId: string,
  shareId: string,
  q: ShareDb = db,
): Promise<ShareSummary | null> {
  if (!UUID_RE.test(shareId)) return null;
  const [row] = await q
    .select()
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Create (or return the existing) active link for a node. Idempotent: "one
 * link per item": if an active link exists, it's returned, with its served
 * list replaced when `serve` is given. Validates owner + shareable type
 * ({@link ShareInputError}). `mode` may only be public: a team link throws
 * {@link TeamLinkRetiredError}. `serve` is stored as given (normalized):
 * the caller checks it first (link-serve.ts, checkServeList). Writes no
 * level and no grant.
 */
export async function createShare(
  ownerId: string,
  nodeId: string,
  opts: { mode?: ShareMode; serve?: readonly string[] } = {},
  q: ShareDb = db,
): Promise<ShareSummary> {
  assertLinkMode(opts.mode);
  const [node] = await q
    .select({ id: nodes.id, type: nodes.type, path: nodes.path, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!node) throw new ShareInputError('not-found', 'node not found');
  if (!isShareable(node.type)) {
    throw new ShareInputError('not-shareable', `type '${node.type}' is not shareable`);
  }
  // A read-only snapshot copy carries no link (W6b fix round 2, L-1; the
  // database refuses it too).
  if (isSnapshotCopy(node)) throw new ShareInputError('not-shareable', SNAPSHOT_COPY_NO_SHARE);
  if (node.type === 'branch' && !isShareableFolderPath(node.path)) {
    throw new ShareInputError('not-shareable', 'only folders under files can be shared');
  }

  const existing = await getActiveShareForNode(ownerId, nodeId, q);
  if (existing) {
    if (opts.serve === undefined) return existing;
    return (await setShareServed(ownerId, existing.id, opts.serve, q)) ?? existing;
  }

  // An expired link (or a team link, retired) is not active but still holds
  // the one-link slot (shares_node_open_uq is WHERE revoked_at IS NULL AND
  // contact_id IS NULL): retire it first, or the insert below violates the
  // index. Contact shares hold slots of their own and are left alone.
  await q
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.nodeId, nodeId),
        isNull(shares.revokedAt),
        isNull(shares.contactId),
        or(lte(shares.expiresAt, new Date()), sql`${shares.settings}->>'mode' = 'team'`),
      ),
    );

  const [row] = await q
    .insert(shares)
    .values({
      ownerId,
      nodeId,
      nodeType: node.type,
      token: genToken(),
      settings: { served: normalizeServed(opts.serve ?? []) },
    })
    .returning();
  if (!row) throw new Error('failed to create share');
  return toSummary(row);
}

/** Replace an active open link's served list (the ids normalized; the
 *  caller checked them, link-serve.ts). Returns the link, or null when no
 *  such active open link. */
export async function setShareServed(
  ownerId: string,
  shareId: string,
  serve: readonly string[],
  q: ShareDb = db,
): Promise<ShareSummary | null> {
  const served = normalizeServed(serve);
  const [row] = await q
    .update(shares)
    .set({
      settings: sql`${shares.settings} || jsonb_build_object('served', ${JSON.stringify(served)}::jsonb)`,
    })
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), openPredicate()))
    .returning();
  return row ? toSummary(row) : null;
}

/** Revoke a share by id (owner-scoped): an open link or a contact share.
 *  Returns true if a row was revoked. Changes no level and no grant. */
export async function revokeShare(
  ownerId: string,
  shareId: string,
  q: ShareDb = db,
): Promise<boolean> {
  const rows = await q
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .returning({ id: shares.id });
  return rows.length > 0;
}

/** Resolve an active OPEN link by its public token. NOT owner-scoped: this
 *  is the public read path. Returns the full row (caller decides what to
 *  expose). A contact share's token never resolves here: a caller that
 *  forgets the contact gate cannot serve one. The /s layer uses
 *  {@link resolveActiveShareRowByToken} behind the gate. */
export async function resolveActiveShareByToken(token: string): Promise<Share | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(shares)
    .where(and(eq(shares.token, token), openPredicate()))
    .limit(1);
  return row ?? null;
}

/** Resolve an active share by its token, an open link or a CONTACT share
 *  (migration 0214). Only the contact share gate (server/web/lib/
 *  contact-share-gate.ts) may serve what this returns for a contact share. */
export async function resolveActiveShareRowByToken(token: string): Promise<Share | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(shares)
    .where(and(eq(shares.token, token), activePredicate()))
    .limit(1);
  return row ?? null;
}

/** Whether a token that no longer resolves was an old client link (client
 *  logins C3): marked `retired: 'client'` (by 0192, a revoke of a client
 *  item's link before W5b2, or 0262). The /s page tells its visitor to sign
 *  in as a client instead of the plain not-found; any other dead token keeps
 *  the uniform 404. */
export async function isRetiredClientLinkToken(token: string): Promise<boolean> {
  if (!token) return false;
  const [row] = await db
    .select({ id: shares.id })
    .from(shares)
    .where(
      and(
        eq(shares.token, token),
        isNull(shares.contactId),
        sql`${shares.settings}->>'retired' = 'client'`,
      ),
    )
    .limit(1);
  return !!row;
}

/** Whether a token that no longer resolves was a team link (revoked by 0176,
 *  or later). The /s page tells its visitor to sign in as a member instead of
 *  the plain not-found; any other dead token keeps the uniform 404. */
export async function isRetiredTeamLinkToken(token: string): Promise<boolean> {
  if (!token) return false;
  const [row] = await db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.token, token), sql`${shares.settings}->>'mode' = 'team'`))
    .limit(1);
  return !!row;
}

/** Best-effort view counter bump for a token (fire-and-forget by callers).
 *  Callers do not await it, so a database that refuses writes (a read-only
 *  replica, a reader role) is caught here: the view is served and not
 *  counted, instead of an unhandled rejection per view. */
export async function recordShareView(shareId: string): Promise<void> {
  // The brain's count, not the link's write: a public link writes nothing
  // (arch A3a, the read-only refusal), so it runs as a named read-path write.
  await bestEffortWrite('a share view counter', () =>
    runReadPathWrite('backfill:link-views', () =>
      db
        .update(shares)
        .set({ viewCount: sql`${shares.viewCount} + 1`, lastViewedAt: new Date() })
        .where(eq(shares.id, shareId)),
    ),
  );
}

export type ActiveShareListing = ShareSummary & {
  /** Display fields joined off the shared node. */
  title: string;
  /** A contact share's contact, by name (migration 0214); null on an open
   *  link. */
  contactName: string | null;
  nodeIcon: string | null;
  nodePath: string | null;
  lastViewedAt: string | null;
};

/** Every ACTIVE share the owner has, newest first — the "what is exposed right
 *  now" registry behind the owner's shared-links overview: open links and
 *  contact shares (0214, with the contact's name). One query. Inner join:
 *  shares.node_id is ON DELETE CASCADE, so a share never outlives its node
 *  (nor its contact: shares.contact_id cascades too). */
export async function listActiveShares(ownerId: string): Promise<ActiveShareListing[]> {
  const contact = alias(nodes, 'share_contact');
  const rows = await db
    .select({
      share: shares,
      title: nodes.title,
      data: nodes.data,
      path: nodes.path,
      contactName: contact.title,
    })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .leftJoin(contact, eq(contact.id, shares.contactId))
    .where(and(eq(shares.ownerId, ownerId), activePredicate()))
    .orderBy(sql`${shares.createdAt} DESC`);
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      ...toSummary(r.share),
      title: r.title,
      contactName: r.share.contactId ? (r.contactName ?? '') : null,
      nodeIcon: typeof d.icon === 'string' ? d.icon : null,
      nodePath: r.path ?? null,
      lastViewedAt: r.share.lastViewedAt ? r.share.lastViewedAt.toISOString() : null,
    };
  });
}

/** An old client link the brain retired (client logins C3), for Shared
 *  links: which customer URLs stopped, and how much they were used. */
export type RetiredClientLinkListing = {
  id: string;
  nodeId: string;
  nodeType: string;
  title: string;
  nodeIcon: string | null;
  /** The level the link was retired at: always client (levels are frozen,
   *  grants decide who reads the item now). */
  level: ViewerLevel;
  createdAt: string;
  retiredAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
};

/** Every link marked `retired: 'client'`, newest retirement first. The
 *  token is never listed: the link is dead, and a client signs in. */
export async function listRetiredClientLinks(ownerId: string): Promise<RetiredClientLinkListing[]> {
  const rows = await db
    .select({ share: shares, title: nodes.title, data: nodes.data })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(and(eq(shares.ownerId, ownerId), sql`${shares.settings}->>'retired' = 'client'`))
    .orderBy(sql`${shares.revokedAt} DESC NULLS LAST`, sql`${shares.createdAt} DESC`);
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      id: r.share.id,
      nodeId: r.share.nodeId,
      nodeType: r.share.nodeType,
      title: r.title,
      nodeIcon: typeof d.icon === 'string' ? d.icon : null,
      level: 'client' as const,
      createdAt: r.share.createdAt.toISOString(),
      retiredAt: r.share.revokedAt ? r.share.revokedAt.toISOString() : null,
      viewCount: r.share.viewCount,
      lastViewedAt: r.share.lastViewedAt ? r.share.lastViewedAt.toISOString() : null,
    };
  });
}

/** Set a share's mode (the owner PATCH path, `node_share` / `page_share`
 *  with a mode). Public is the only mode: a live link already is, so this
 *  confirms the link. Team throws {@link TeamLinkRetiredError} and changes
 *  nothing. Returns false when no such active share. */
export async function applyShareMode(
  ownerId: string,
  shareId: string,
  mode: ShareMode,
  q: ShareDb = db,
): Promise<boolean> {
  assertLinkMode(mode);
  const [row] = await q
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), openPredicate()))
    .limit(1);
  return !!row;
}

/** Revoke a share on the owner DELETE path. The name is from when a page
 *  link could cascade to its sub-pages (folder phase 7 retired that: pages
 *  do not nest); it is {@link revokeShare} now, kept as the drop-in the
 *  unshare paths call. */
export async function revokeShareTree(
  ownerId: string,
  shareId: string,
  q: ShareDb = db,
): Promise<boolean> {
  return revokeShare(ownerId, shareId, q);
}
