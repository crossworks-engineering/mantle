/**
 * Share-link CRUD. A share is a revocable token granting read-only public
 * access to one node. The owner toggles a link on/off; the public surface
 * resolves strictly by an *active* token. See docs/sharing.md.
 *
 * Token: 16 random bytes (128-bit) as base64url (~22 url-safe chars).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  bestEffortWrite,
  db,
  nodes,
  shares,
  WORKSPACE_NODE_TYPES,
  type Share,
  type ViewerLevel,
} from '@mantle/db';
import type { ShareMode } from '@mantle/client-types';
import { env } from '@mantle/config';
import { EMBEDDING_KINDS, levelAbove, lowerEmbedClosure, type LoweredItem } from './embed-closure';
import { refoldPageTexts } from './pages/level-text';

export type { ShareMode };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Where a share read or write runs: the pool, or a caller's transaction
 *  (`setItemLevel` writes the level and the link as one). Every function
 *  below that takes one runs ALL its reads and writes through it: a write on
 *  the pool while the caller's transaction holds the row would wait on itself. */
export type ShareDb = typeof db | Tx;

/** Node types that may be shared publicly. Sensitive types are excluded.
 *  `branch` = a FILES FOLDER only — sharing one shares every file under it,
 *  subfolders included, evaluated per request (see {@link isShareableFolderPath}
 *  and docs/sharing.md §folders). Branches outside the files tree (and the
 *  files root itself) are rejected at {@link createShare}. */
export const SHAREABLE_TYPES = [
  'page',
  'note',
  'task',
  'event',
  'file',
  'app',
  'table',
  // A formula is a calculation model, and the shared surface is a live
  // calculator — the point of sending someone a link is that they can put their
  // own numbers in and see the derivation, not just read the equations.
  'formula',
  // A draw shares its COMMITTED SVG snapshot (validated by acceptSceneSvg at
  // commit) — never the scene JSON, never the draft. Static pixels, no JS.
  'draw',
  'branch',
] as const;
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
  if (!isShareable(node.type)) return false;
  return node.type !== 'branch' || isShareableFolderPath(node.path);
}

// ─── Levels drive links ──────────────────────────────────────────────────────
// A workspace item's level (nodes.audience) is the truth; its link follows it
// (docs/access-levels.md §7). Public items carry an open link; admin, team and
// client items carry none. Client means "signed-in clients" (client logins
// C1), never an open link: no path makes a new link on a client item
// (ClientLinkRetiredError, inside createShare), and no link of its OWN, old or
// new, changes a client item's level. A link (or the public level) on ANOTHER
// item that embeds it does: embedding means sharing, so the embed goes down
// to public with it and leaves client logins' view (the tools say so, see
// clientLeftWarning in @mantle/tools). A client item's own link, when revoked,
// is marked `settings.retired = 'client'` (retireSettings below), as 0176
// marked team links by their mode. Team links are retired (member logins Phase 6
// stage 6): members read team items by level with their own logins, migration
// 0176 revoked every team link, and nothing makes one (TeamLinkRetiredError).
// Every share mutation below re-derives the level from the link it leaves, so
// the older share paths (the share API, node_share / page_share, the email
// link) cannot drift from the level. Tasks, events and other non-workspace
// kinds stay admin whatever link they carry.

/** The link a level needs: an open one at public, none above (client logins
 *  C1: client is signed-in clients, not a link). */
export function shareModeForLevel(level: ViewerLevel): ShareMode | null {
  return level === 'public' ? 'public' : null;
}

/** Thrown when a link is asked for on a client item (client logins C1): client
 *  items are for signed-in clients, and public is the only level with an
 *  open link. Thrown inside createShare, so every path that makes a link
 *  (node_share, page_share, POST /api/shares, the email link) meets it. */
export class ClientLinkRetiredError extends Error {
  readonly reason = 'client-links-retired';
  constructor() {
    super(
      'Client items have no open link; clients sign in to read them. ' +
        'Ask the owner whether to make it public: that puts it on an open link anyone can use, ' +
        "and takes it out of client logins' view.",
    );
    this.name = 'ClientLinkRetiredError';
  }
}

/** Thrown when a caller asks for a team-mode link. Team links are retired
 *  (member logins Phase 6 stage 6): members use their own logins. */
export class TeamLinkRetiredError extends Error {
  readonly reason = 'team-links-retired';
  constructor() {
    super(
      'Team links are retired: members sign in with their own logins now. ' +
        'To show an item to members, set its level to team (access_set, or the Access control).',
    );
    this.name = 'TeamLinkRetiredError';
  }
}

/** Refuse any link mode but public (an untyped caller may still pass 'team'). */
function assertLinkMode(mode: string | undefined): void {
  if (mode !== undefined && mode !== 'public') throw new TeamLinkRetiredError();
}

/**
 * The level a node's link implies. A node at client stays at client whatever
 * its own link says (client logins C1: until the old client links are retired
 * they are still live, and no re-sync may flip them, or their embeds, to
 * public or admin). `mode` null = no active link: admin, except that a node
 * at team stays at team (team is a level members read by, not a link). An
 * open link keeps a node at public and drops anything higher to public.
 */
export function levelForShareMode(current: ViewerLevel, mode: ShareMode | null): ViewerLevel {
  if (current === 'client') return 'client';
  if (mode === null) return current === 'team' ? 'team' : 'admin';
  return 'public';
}

/** Re-derive the level of `nodeIds` from their active links (workspace kinds
 *  only). A node this LOWERS takes its embeds down with it (embedding means
 *  sharing, embed-closure.ts), in one transaction with its own level; what
 *  went down is pushed to `alsoLowered` when given. */
async function syncLevelsFromShares(
  ownerId: string,
  nodeIds: readonly string[],
  q: ShareDb = db,
  alsoLowered?: LoweredItem[],
): Promise<void> {
  const ids = [...new Set(nodeIds)];
  if (ids.length === 0) return;
  const [rows, links] = await Promise.all([
    q
      .select({ id: nodes.id, type: nodes.type, audience: nodes.audience })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, ids))),
    q
      .select({ nodeId: shares.nodeId })
      .from(shares)
      .where(and(eq(shares.ownerId, ownerId), inArray(shares.nodeId, ids), openPredicate())),
  ]);
  // Every active OPEN link is public (team links are retired and never
  // active). A contact share (0214) is not read here: it never sets a level.
  const linked = new Set(links.map((l) => l.nodeId));
  const byTarget = new Map<ViewerLevel, string[]>();
  const followers: { id: string; level: ViewerLevel }[] = [];
  for (const r of rows) {
    if (!(WORKSPACE_NODE_TYPES as readonly string[]).includes(r.type)) continue;
    const current = r.audience as ViewerLevel;
    const target = levelForShareMode(current, linked.has(r.id) ? 'public' : null);
    if (target === current) continue;
    byTarget.set(target, [...(byTarget.get(target) ?? []), r.id]);
    if (levelAbove(current, target) && EMBEDDING_KINDS.includes(r.type)) {
      followers.push({ id: r.id, level: target });
    }
  }
  if (byTarget.size === 0) return;
  await q.transaction(async (tx) => {
    for (const [audience, targetIds] of byTarget) {
      await tx
        .update(nodes)
        .set({ audience })
        .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, targetIds)));
    }
    for (const f of followers) {
      const { lowered } = await lowerEmbedClosure(ownerId, f.id, f.level, tx);
      alsoLowered?.push(...lowered);
    }
    // The indexed text follows the levels (pages/level-text.ts, SQL only).
    await refoldPageTexts(ownerId, [...byTarget.values()].flat(), tx);
  });
}

/**
 * Make a node's link match the level it was just set to: revoke it at admin
 * team and client, create it at public. Returns the link left in place (null
 * below public, or when the node cannot carry one, e.g. a folder outside
 * `files`). The
 * owner's level path (`setItemLevel`) calls this after writing the level.
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

/** SQL predicate: an active OPEN link (no contact). Every level path reads
 *  open links only: a contact share (migration 0214) never sets, keeps or
 *  drops a level, and a level change never touches one. */
function openPredicate() {
  return and(activePredicate(), isNull(shares.contactId));
}

/** The `settings` a revoke writes: unchanged, except that a link on an item
 *  at CLIENT is marked `retired: 'client'` (client logins C1: client is
 *  signed-in clients, so its old open link retires with the revoke). Read at
 *  the moment of the revoke: `setItemLevel` writes the level before the link
 *  follows it. /s reads the mark (isRetiredClientLinkToken, C3) and answers
 *  "sign in as a client"; Shared links lists these (listRetiredClientLinks). */
function retireSettings() {
  // Qualified by hand: drizzle renders a column unqualified inside raw sql,
  // and inside the subquery it must name the row being updated. A contact
  // share is never an old client link, whatever its item's level.
  return sql`case when "shares"."contact_id" is null and exists (select 1 from ${nodes} rn
      where rn.id = "shares"."node_id" and rn.audience = 'client')
    then "shares"."settings" || '{"retired":"client"}'::jsonb
    else "shares"."settings" end`;
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

/**
 * Create (or return the existing) active share for a node. Idempotent —
 * "one link per item": if an active link exists, it's returned unchanged.
 * Validates owner + shareable type. `mode` may only be public: a team link
 * throws {@link TeamLinkRetiredError}. A node the link lowers takes its
 * embeds with it; `alsoLowered` collects them for the caller to show.
 */
export async function createShare(
  ownerId: string,
  nodeId: string,
  opts: { mode?: ShareMode; alsoLowered?: LoweredItem[] } = {},
  q: ShareDb = db,
): Promise<ShareSummary> {
  assertLinkMode(opts.mode);
  const [node] = await q
    .select({ id: nodes.id, type: nodes.type, path: nodes.path, audience: nodes.audience })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!node) throw new Error('node not found');
  if (!isShareable(node.type)) throw new Error(`type '${node.type}' is not shareable`);
  if (node.type === 'branch' && !isShareableFolderPath(node.path)) {
    throw new Error('only folders under files can be shared');
  }
  // Client items are for signed-in clients (client logins C1). Before the
  // idempotent return: an old client link is not handed out again either.
  if (node.audience === 'client') throw new ClientLinkRetiredError();

  const existing = await getActiveShareForNode(ownerId, nodeId, q);
  if (existing) return existing;

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
    .values({ ownerId, nodeId, nodeType: node.type, token: genToken() })
    .returning();
  if (!row) throw new Error('failed to create share');
  await syncLevelsFromShares(ownerId, [nodeId], q, opts.alsoLowered);
  return toSummary(row);
}

/** Revoke a share by id (owner-scoped). Returns true if a row was revoked.
 *  Revoking a contact share (0214) is a revoke only: no level is
 *  re-derived, since a contact share never set one. */
export async function revokeShare(
  ownerId: string,
  shareId: string,
  q: ShareDb = db,
): Promise<boolean> {
  const rows = await q
    .update(shares)
    .set({ revokedAt: new Date(), settings: retireSettings() })
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .returning({ id: shares.id, nodeId: shares.nodeId, contactId: shares.contactId });
  await syncLevelsFromShares(
    ownerId,
    rows.filter((r) => r.contactId === null).map((r) => r.nodeId),
    q,
  );
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
    .where(and(eq(shares.token, token), openPredicate(), notOnClientItem()))
    .limit(1);
  return row ?? null;
}

/** Resolve an active share by its token, an open link or a CONTACT share
 *  (migration 0214). An open link on a client item never resolves (as
 *  above); a contact share does (it is not an open link, and the item stays
 *  at client). Only the contact share gate (server/web/lib/
 *  contact-share-gate.ts) may serve what this returns for a contact share. */
export async function resolveActiveShareRowByToken(token: string): Promise<Share | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(shares)
    .where(
      and(
        eq(shares.token, token),
        activePredicate(),
        or(isNotNull(shares.contactId), notOnClientItem()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** SQL predicate: the share's item is not at CLIENT level. The public read
 *  path never serves a link on a client item (client logins C3: migration
 *  0192 revoked them all; one that somehow stayed live answers "sign in as
 *  a client" like the rest). Qualified by hand, as in retireSettings. */
function notOnClientItem() {
  return sql`not exists (select 1 from ${nodes} cn
      where cn.id = "shares"."node_id" and cn.audience = 'client')`;
}

/** Whether a token that no longer resolves was an old client link (client
 *  logins C3): marked `retired: 'client'` (0192 and every later revoke of a
 *  client item's link), or a link on an item that is at client now. The /s
 *  page tells its visitor to sign in as a client instead of the plain
 *  not-found; any other dead token keeps the uniform 404. */
export async function isRetiredClientLinkToken(token: string): Promise<boolean> {
  if (!token) return false;
  const [row] = await db
    .select({ id: shares.id })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        eq(shares.token, token),
        isNull(shares.contactId),
        or(sql`${shares.settings}->>'retired' = 'client'`, eq(nodes.audience, 'client')),
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
  await bestEffortWrite('a share view counter', () =>
    db
      .update(shares)
      .set({ viewCount: sql`${shares.viewCount} + 1`, lastViewedAt: new Date() })
      .where(eq(shares.id, shareId)),
  );
}

export type ActiveShareListing = ShareSummary & {
  /** Display fields joined off the shared node. */
  title: string;
  /** A contact share's contact, by name (migration 0214); null on an open
   *  link. */
  contactName: string | null;
  /** The shared item's level (client logins C1: a live link on a client
   *  item is an old one, from when client meant an open link). */
  level: ViewerLevel;
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
      audience: nodes.audience,
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
      level: r.audience as ViewerLevel,
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
  /** The item's level now (client, unless an admin changed it since). */
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
    .select({ share: shares, title: nodes.title, data: nodes.data, audience: nodes.audience })
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
      level: r.audience as ViewerLevel,
      createdAt: r.share.createdAt.toISOString(),
      retiredAt: r.share.revokedAt ? r.share.revokedAt.toISOString() : null,
      viewCount: r.share.viewCount,
      lastViewedAt: r.share.lastViewedAt ? r.share.lastViewedAt.toISOString() : null,
    };
  });
}

/** Set a share's mode (the owner PATCH path, `node_share` / `page_share`
 *  with a mode). Public is the only mode: a live link already is, so this
 *  confirms the link and re-derives its node's level. Team throws
 *  {@link TeamLinkRetiredError} and changes nothing. Returns false when no
 *  such active share. */
export async function applyShareMode(
  ownerId: string,
  shareId: string,
  mode: ShareMode,
  q: ShareDb = db,
): Promise<boolean> {
  assertLinkMode(mode);
  const [row] = await q
    .select()
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), openPredicate()))
    .limit(1);
  if (!row) return false;
  await syncLevelsFromShares(ownerId, [row.nodeId], q);
  return true;
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
