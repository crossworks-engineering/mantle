/**
 * Take over (audit F07, Jason 2026-09-28): an admin takes a SUBMITTED member
 * item, and the bundle it was submitted with, out of the Review queue into
 * their OWN private space (Phase 7) to work on it, then accepts it into the
 * brain from there or gives it back to the member.
 *
 * This module holds the parts that are not the review queue's:
 *  - `moveBetweenSpaces`: re-own items from one personal space to another in
 *    the caller's transaction (same ids; bytes and workbooks staged, removed
 *    again on a rollback, the old copies removed after the commit; page paths
 *    rebuilt; file names made unique). The Take over itself (member-review.ts,
 *    it reads the queue's rule) and Give back both use it.
 *  - `takenGroup`: what was taken together (`space_items.taken_root`).
 *  - `giveBackTakenItem`: the group back to the member's space, the item
 *    `returned` with a note.
 *  - whom the ADMIN took it from (`takenFromOf`). What the MEMBER sees while
 *    an admin holds their item (`with-admin`) is in member-space.ts.
 *
 * A taken item stays a personal item the whole time: never indexed, embedded
 * or extracted. Take over, the admin's saves and Give back start no LLM
 * work; only Accept announces anything to the extractor (member-review.ts).
 *
 * Admin pool only (the rule is in every query, as in member-review.ts):
 * none of this runs inside a viewer or space scope.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  asSystem,
  authUsers,
  currentSpaceScope,
  currentViewerLevel,
  db,
  draws,
  nodes,
  pages,
  spaceItems,
  spaces,
  tables,
  withViewer,
} from '@mantle/db';
import type { AdminTakenFrom } from '@mantle/client-types';
import {
  MEMBER_ITEM_KINDS as SPACE_ITEM_KINDS,
  type MemberItemKind as SpaceItemKind,
} from '@mantle/client-types/member-kinds';
import { extOf, mimeForExt, removeSpaceFile, spaceFilePath } from '@mantle/files';
import {
  publishedPath,
  relativeStoragePath,
  resolveStoragePath,
  snapshotFile,
} from '@mantle/tabledb';
import { lockBundleRows, refsOf, type BundleItem } from './member-bundle';
import { clientOwnUrl } from './client-redact';
import { clientRedactOrigins } from './client-origins';
import { SpaceItemStateError, spaceNotFound } from './member-space-core';
import { notifySpaceItemChanged } from './member-space-events';
import {
  SPACE_FILES_PATH,
  clientSpacesUsed,
  lockClientTotal,
  spaceStorageUsed,
} from './member-space-files';
import { CLIENT_SPACE_LIMITS, clientSpacesTotalBytes } from './space-limits';
import { recordClientQuotaRefusal } from './client-quota-log';
import { savedState } from './member-space';
import { draftAbsFor, removeTableFile } from './table-storage';
import { dedupeFilename } from './dedupe-filename';
import { PAGES_ROOT_LABEL } from './pages/shared';
import { NOTES_ROOT_LABEL } from './notes';
import { DRAWS_ROOT_LABEL } from './draws';
import { TABLES_ROOT_LABEL } from './tables/shared';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Via = Pick<Tx, 'select'>;

/** Work to do once the transaction has ended, one way or the other. */
export type MoveHooks = {
  onCommit: (() => Promise<unknown>)[];
  onRollback: (() => Promise<unknown>)[];
};

function assertAdminPool(what: string): void {
  if (currentViewerLevel() !== 'admin' || currentSpaceScope()) {
    throw new Error(`${what} runs on the admin pool: call it outside a viewer scope`);
  }
}

// ── The move ────────────────────────────────────────────────────────────────

const ROOTS: Partial<Record<SpaceItemKind, { label: string; title: string }>> = {
  page: { label: PAGES_ROOT_LABEL, title: 'Pages' },
  note: { label: NOTES_ROOT_LABEL, title: 'Notes' },
  draw: { label: DRAWS_ROOT_LABEL, title: 'Draw' },
  table: { label: TABLES_ROOT_LABEL, title: 'Tables' },
};

/**
 * Re-own `items` from personal space `from` to personal space `to`, in `tx`.
 * Same node ids. A page and a note keep their path (a brain folder's path
 * means the same in every space; folder phase 7: pages do not nest); a file
 * gets a name `to` does not hold yet; a table's workbook is
 * copied (VACUUM INTO) and a file's bytes are copied into `to` now, the old
 * ones removed after the commit (`hooks`). Leftover drafts are discarded:
 * what moves is the SAVED version. Rows only: nothing is announced.
 */
export async function moveBetweenSpaces(
  tx: Tx,
  from: string,
  to: string,
  items: BundleItem[],
  hooks: MoveHooks,
): Promise<void> {
  if (!items.length || from === to) return;
  for (const kind of new Set(items.map((b) => b.type))) {
    const root = ROOTS[kind];
    if (!root) continue;
    await tx
      .insert(nodes)
      .values({
        ownerId: to,
        type: 'branch',
        title: root.title,
        slug: root.label,
        path: root.label,
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });
  }
  let names: Set<string> | null = null;
  const now = new Date();
  for (const b of items) {
    const [n] = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, b.id), eq(nodes.ownerId, from)))
      .limit(1);
    if (!n) continue;
    const common = { ownerId: to, updatedAt: now };
    switch (b.type) {
      case 'page':
        await tx
          .update(nodes)
          .set({ ...common, parentId: null })
          .where(eq(nodes.id, b.id));
        await tx
          .update(pages)
          .set({ draftDoc: null, draftUpdatedAt: null })
          .where(eq(pages.nodeId, b.id));
        break;
      case 'note':
        await tx.update(nodes).set(common).where(eq(nodes.id, b.id));
        break;
      case 'draw':
        await tx.update(nodes).set(common).where(eq(nodes.id, b.id));
        await tx
          .update(draws)
          .set({ draftScene: null, draftUpdatedAt: null })
          .where(eq(draws.nodeId, b.id));
        break;
      case 'table': {
        const [t] = await tx
          .select({ storagePath: tables.storagePath })
          .from(tables)
          .where(eq(tables.nodeId, b.id))
          .limit(1);
        let storagePath = t?.storagePath ?? null;
        if (storagePath) {
          const src = resolveStoragePath(storagePath);
          const dest = publishedPath(to, b.id);
          snapshotFile(src, dest);
          const old = storagePath;
          hooks.onRollback.push(async () => removeTableFile(dest));
          hooks.onCommit.push(async () => {
            removeTableFile(draftAbsFor(old));
            removeTableFile(src);
          });
          storagePath = relativeStoragePath(to, b.id);
        }
        await tx.update(nodes).set(common).where(eq(nodes.id, b.id));
        await tx
          .update(tables)
          .set({ storagePath, draftData: null, draftUpdatedAt: null })
          .where(eq(tables.nodeId, b.id));
        break;
      }
      case 'file': {
        names ??= await fileNamesOf(tx, to);
        const data = { ...((n.data ?? {}) as Record<string, unknown>) };
        const display =
          typeof data.filename === 'string' && data.filename ? data.filename : n.title;
        const name = dedupeFilename(display, names);
        names.add(name);
        const dest = spaceFilePath(to, b.id);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(spaceFilePath(from, b.id), dest);
        hooks.onRollback.push(() => removeSpaceFile(to, b.id));
        hooks.onCommit.push(() => removeSpaceFile(from, b.id));
        const extension = extOf(name);
        await tx
          .update(nodes)
          .set({
            ...common,
            title: name === display ? n.title : name,
            path: sql`${SPACE_FILES_PATH}::ltree`,
            data: { ...data, filename: name, extension, mime_type: mimeForExt(extension) },
          })
          .where(eq(nodes.id, b.id));
        break;
      }
    }
  }
}

/** The file names a space already uses (the unique index is per owner, path
 *  and filename). */
async function fileNamesOf(via: Via, spaceId: string): Promise<Set<string>> {
  const rows = await via
    .select({ name: sql<string | null>`${nodes.data} ->> 'filename'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, spaceId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${SPACE_FILES_PATH}`,
      ),
    );
  return new Set(rows.flatMap((r) => (r.name ? [r.name] : [])));
}

/** Run a transaction whose disk work follows it: staged copies removed on a
 *  rollback, old copies removed after the commit. */
export async function withMoveHooks<T>(fn: (tx: Tx, hooks: MoveHooks) => Promise<T>): Promise<T> {
  const hooks: MoveHooks = { onCommit: [], onRollback: [] };
  let result: T;
  try {
    result = await db.transaction((tx) => fn(tx, hooks));
  } catch (err) {
    for (const f of hooks.onRollback) await f().catch(() => {});
    throw err;
  }
  for (const f of hooks.onCommit) {
    await f().catch((err: unknown) =>
      console.error('[member-takeover] removing moved bytes failed:', err),
    );
  }
  return result;
}

// ── What was taken together ────────────────────────────────────────────────

/** The group key of a taken row: its root's id (the root holds NULL). */
const groupKey = sql<string>`coalesce(${spaceItems.takenRoot}, ${spaceItems.nodeId})`;

/**
 * Everything in `spaceId` that was taken together with `id` (its root and
 * the root's bundle, whatever is still there), the root first, a parent page
 * before its children. Empty when `id` is not a taken item of that space.
 */
export async function takenGroup(via: Via, spaceId: string, id: string): Promise<BundleItem[]> {
  const [me] = await via
    .select({ key: groupKey })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .where(
      and(
        eq(spaceItems.nodeId, id),
        eq(nodes.ownerId, spaceId),
        eq(spaceItems.reviewState, 'taken'),
      ),
    )
    .limit(1);
  if (!me) return [];
  const rows = await via
    .select({ id: nodes.id, type: nodes.type, title: nodes.title })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .where(
      and(
        eq(nodes.ownerId, spaceId),
        eq(spaceItems.reviewState, 'taken'),
        sql`${groupKey} = ${me.key}`,
        inArray(nodes.type, [...SPACE_ITEM_KINDS]),
      ),
    )
    .orderBy(
      desc(sql`${nodes.id} = ${me.key}`),
      asc(sql`case when ${nodes.type} = 'page' then nlevel(${nodes.path}) else 0 end`),
    );
  return rows.map((r) => ({ id: r.id, type: r.type as SpaceItemKind, title: r.title }));
}

/** After items left a group (accepted, deleted), each item still taken with
 *  them becomes a root of its own, so it stays reachable (the queue lists
 *  roots, give-back finds its group). */
export async function detachFromGroups(tx: Pick<Tx, 'update'>, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await tx
    .update(spaceItems)
    .set({ takenRoot: null })
    .where(and(inArray(spaceItems.takenRoot, ids), notInArray(spaceItems.nodeId, ids)));
}

// ── The author ─────────────────────────────────────────────────────────────

/** The roles an item can go back to, and the level each is held to (client
 *  logins C1): a member reads the brain at team, a client at client. Admins
 *  never author a reviewable item; any other role is no author. */
export const AUTHOR_LEVELS = { member: 'team', client: 'client' } as const;
export type AuthorRole = keyof typeof AUTHOR_LEVELS;

export function isAuthorRole(role: string | null | undefined): role is AuthorRole {
  return role === 'member' || role === 'client';
}

/** The author login an item can go back to: it exists, is a member or a
 *  client, and is not deactivated. Its personal space and the level its
 *  embed rule reads at, or null. */
async function authorSpaceOf(
  via: Via,
  loginId: string | null,
): Promise<{ spaceId: string; level: 'team' | 'client' } | null> {
  if (!loginId) return null;
  const [r] = await via
    .select({ spaceId: spaces.id, role: authUsers.role })
    .from(spaces)
    .innerJoin(authUsers, eq(authUsers.id, spaces.loginId))
    .where(
      and(
        eq(spaces.kind, 'personal'),
        eq(spaces.loginId, loginId),
        inArray(authUsers.role, ['member', 'client']),
        isNull(authUsers.disabledAt),
      ),
    )
    .limit(1);
  if (!r || !isAuthorRole(r.role)) return null;
  return { spaceId: r.spaceId, level: AUTHOR_LEVELS[r.role] };
}

/** A login's personal space, whatever the login is now (the realtime event
 *  of a change to an item it wrote). */
export async function personalSpaceOf(via: Via, loginId: string | null): Promise<string | null> {
  if (!loginId) return null;
  const [r] = await via
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.kind, 'personal'), eq(spaces.loginId, loginId)))
    .limit(1);
  return r?.id ?? null;
}

// ── Give back ──────────────────────────────────────────────────────────────

export type GiveBackResult = { id: string; returned: BundleItem[] };

/**
 * The embed rule the AUTHOR is held to (member-space.ts `disallowedRefs`),
 * checked before their item comes back: its saved versions may use only
 * what was taken with it, the author's own items and the brain items they
 * can read, at THEIR level (team for a member, client for a client: client
 * logins C1, plan N3). An admin may have added a brain item at any level,
 * or one of their own private items, while it was theirs: giving that back
 * would show the author an id, a title in a mention chip, or a link to
 * something they may not read. An absolute URL into this brain is read as
 * the reference it stands for, as the client redactor reads it (audit L2).
 * Returns the ids that are not allowed.
 */
async function refsTheAuthorMayNotUse(
  tx: Via,
  brainId: string,
  author: { spaceId: string; level: 'team' | 'client' },
  group: BundleItem[],
): Promise<string[]> {
  const memberSpaceId = author.spaceId;
  const inGroup = new Set(group.map((g) => g.id));
  const ids = new Set<string>();
  const refused = new Set<string>();
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  for (const item of group) {
    for (const r of await refsOf(tx, item, ownUrl)) {
      for (const id of r.ids) if (!inGroup.has(id)) ids.add(id);
      for (const x of r.refused) refused.add(x);
    }
  }
  const rest = [...ids];
  if (!rest.length) return [...refused];
  const own = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, memberSpaceId), inArray(nodes.id, rest)));
  const ok = new Set(own.map((r) => r.id));
  const others = rest.filter((id) => !ok.has(id));
  if (others.length) {
    // The brain, read as the author's level reads it (row security decides).
    const lib = await withViewer(author.level, () =>
      db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.ownerId, brainId), inArray(nodes.id, others))),
    );
    for (const r of lib) ok.add(r.id);
  }
  return [...refused, ...rest.filter((id) => !ok.has(id))];
}

/**
 * Give a taken item back to the member who wrote it (audit F07): the acting
 * admin's `own` space must hold it, taken. Everything taken with it goes back
 * to the member's space in one transaction (same ids, bytes moved back), the
 * item (and the group's root) `returned` with `note` (the member sees it as
 * the Return banner, edits, and submits again), the rest as drafts. Private
 * to the member again: sharing stays private.
 *
 * Refused (SpaceItemStateError): `not-found` (not a taken item in this
 * space), `invalid` (no note), `author-inactive` (the member is deactivated,
 * deleted or no longer a member: accept or delete it instead),
 * `unsaved-draft` (save a version of each listed item first) and `embed`
 * (the listed ids are things the member may not use: remove them first).
 * Rows and bytes only: no LLM work.
 */
export async function giveBackTakenItem(
  brainId: string,
  own: { spaceId: string; loginId: string },
  id: string,
  note: string,
): Promise<GiveBackResult> {
  return giveBackTaken(
    brainId,
    { spaceId: own.spaceId, reviewerId: own.loginId, spaceLogin: own.loginId },
    id,
    note,
  );
}

/**
 * The give-back itself, from the space `from.spaceId` holds the item in:
 * the acting admin's own (`spaceLogin` names them: the space must be theirs),
 * or, for Return on a taken item whose admin is gone (member-review.ts), that
 * admin's space: `locate` then re-proves, under the lock, that it is still
 * released, and `dropDrafts` lets the gone admin's unsaved edits go (nobody
 * can save them now) instead of refusing.
 */
export async function giveBackTaken(
  brainId: string,
  from: { spaceId: string; reviewerId: string; spaceLogin?: string },
  id: string,
  note: string,
  opts: { locate?: (tx: Tx) => Promise<boolean>; dropDrafts?: boolean } = {},
): Promise<GiveBackResult> {
  assertAdminPool('giveBackTaken');
  const text = note.trim().slice(0, 4000);
  if (!text) throw new SpaceItemStateError('invalid', 'Say what needs to change.');
  const own = { spaceId: from.spaceId, loginId: from.reviewerId };
  const result = await withMoveHooks(async (tx, hooks) => {
    // The state row, locked, in that space.
    const [row] = await tx
      .select({ author: spaceItems.authorLoginId, key: groupKey })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .where(
        and(
          eq(spaceItems.nodeId, id),
          eq(nodes.ownerId, from.spaceId),
          eq(spaces.kind, 'personal'),
          from.spaceLogin ? eq(spaces.loginId, from.spaceLogin) : undefined,
          eq(spaceItems.reviewState, 'taken'),
        ),
      )
      .for('update', { of: spaceItems })
      .limit(1);
    if (!row) throw spaceNotFound();
    if (opts.locate && !(await opts.locate(tx))) throw spaceNotFound();
    const author = await authorSpaceOf(tx, row.author);
    if (!author) {
      throw new SpaceItemStateError(
        'author-inactive',
        'The person who wrote this cannot take it back (deactivated, removed, or no longer a member or client). Accept it into the brain or delete it.',
      );
    }
    const memberSpace = author.spaceId;
    const group = await takenGroup(tx, own.spaceId, id);
    if (!group.length) throw spaceNotFound();
    await lockBundleRows(tx, group);
    const unsaved: BundleItem[] = [];
    if (!opts.dropDrafts) {
      for (const b of group) if ((await savedState(b.type, b.id, tx)).unsaved) unsaved.push(b);
    }
    if (unsaved.length) {
      const names = unsaved.map((b) => `"${b.title}"`).join(', ');
      throw new SpaceItemStateError(
        'unsaved-draft',
        `Unsaved changes on ${names}. Save a version of each, then give it back.`,
        unsaved.map((b) => b.id),
      );
    }
    const bad = await refsTheAuthorMayNotUse(tx, brainId, author, group);
    if (bad.length) {
      throw new SpaceItemStateError(
        'embed',
        `This item now uses things its author may not see (brain items above ${author.level} level, or your own private items). Remove them, save, then give it back.`,
        bad,
      );
    }

    await moveBetweenSpaces(tx, own.spaceId, memberSpace, group, hooks);
    if (author.level === 'client') await assertClientRoomAfterGiveBack(tx, memberSpace, row.author);
    const ids = group.map((g) => g.id);
    const now = new Date();
    const cleared = {
      takenBy: null,
      takenAt: null,
      takenRoot: null,
      takenTitle: null,
      updatedAt: now,
    };
    await tx
      .update(spaceItems)
      .set({ ...cleared, reviewState: 'draft', submittedAt: null, sharing: 'private' })
      .where(inArray(spaceItems.nodeId, ids));
    const back = [...new Set([id, row.key])].filter((x) => ids.includes(x));
    await tx
      .update(spaceItems)
      .set({
        reviewState: 'returned',
        returnedNote: text,
        reviewedBy: own.loginId,
        reviewedAt: now,
      })
      .where(inArray(spaceItems.nodeId, back));
    for (const g of group) {
      await notifySpaceItemChanged(g.id, 'state', { spaceId: memberSpace, team: false }, tx);
    }
    return { id, returned: group };
  });
  return result;
}

/**
 * A give back into a CLIENT's space holds the client limits (audit I7): the
 * items and bytes it brings back count like the client's own. Checked with
 * the move in place, under the space's quota lock and the client total's
 * (the order an upload takes them), so an upload cannot pass the same last
 * room. Over any limit: 409 `quota` (the move rolls back with the
 * transaction), and the refusal is recorded. Accept it or delete it instead.
 */
async function assertClientRoomAfterGiveBack(
  tx: Tx,
  spaceId: string,
  authorLoginId: string | null,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`space-quota:${spaceId}`}, 0))`,
  );
  await lockClientTotal(tx);
  const lim = CLIENT_SPACE_LIMITS;
  const [held] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, spaceId), ne(nodes.type, 'branch')));
  const over =
    (held?.n ?? 0) > lim.itemLimit ||
    (await spaceStorageUsed(spaceId, tx)) > lim.storageBytes ||
    (await clientSpacesUsed(tx)) > clientSpacesTotalBytes();
  if (!over) return;
  await recordClientQuotaRefusal(authorLoginId, 'give-back');
  throw new SpaceItemStateError(
    'quota',
    'The client’s space has no room for this (its item or storage limit, or the storage for all clients). Accept it into the brain or delete it instead.',
  );
}

// ── Whom the admin took it from ────────────────────────────────────────────

/**
 * For the taken items among `ids` in the admin's `spaceId`: who wrote each
 * one (the admin space list's `takenFrom`). Other ids are left out. Admin
 * pool (asSystem): the space role reads no login row.
 */
export async function takenFromOf(
  spaceId: string,
  ids: readonly string[],
): Promise<Map<string, AdminTakenFrom>> {
  const out = new Map<string, AdminTakenFrom>();
  if (!ids.length) return out;
  const rows = await asSystem(() =>
    db
      .select({
        id: spaceItems.nodeId,
        loginId: authUsers.id,
        displayName: authUsers.displayName,
        email: authUsers.email,
        role: authUsers.role,
        disabledAt: authUsers.disabledAt,
        takenAt: spaceItems.takenAt,
      })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
      .where(
        and(
          inArray(spaceItems.nodeId, [...ids]),
          eq(nodes.ownerId, spaceId),
          eq(spaceItems.reviewState, 'taken'),
        ),
      ),
  );
  for (const r of rows) {
    out.set(r.id, {
      loginId: r.loginId ?? null,
      name: r.loginId
        ? r.displayName?.trim() || r.email?.split('@')[0] || 'A member'
        : 'Removed member',
      canGiveBack: !!r.loginId && isAuthorRole(r.role) && r.disabledAt === null,
      takenAt: r.takenAt?.toISOString() ?? null,
    });
  }
  return out;
}
