/**
 * The deactivation purge (member logins Phase 4, plan v3.1 section 6.4;
 * decided 2026-09-26: 30 days, then purge; admins never browse them).
 *
 * When a login has been deactivated for SPACE_PURGE_GRACE_DAYS, its PRIVATE
 * personal items are deleted, rows and bytes. What it shared with the team,
 * and what it submitted, stays: those are offered to an admin to accept or
 * discard (member-review.ts), because the team or the reviewer can already
 * read them. A space left with no items at all loses its directories too:
 * MANTLE_SPACES_ROOT/<space> and TABLE_DB_DIR/<space> (audit D6).
 *
 * Pure SQL and file removal: no LLM, nothing reacts to it. Runs from the
 * nightly maintenance sweep (`space-purge`) and the CLI script. Reports
 * counts only, never titles: admins never browse a member's private items.
 */
import path from 'node:path';
import { constants } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { and, eq, inArray, isNotNull, lte, ne, notInArray, or, isNull, sql } from 'drizzle-orm';
import { authUsers, db, nodes, spaceItems, spaces, tables } from '@mantle/db';
import { removeSpaceFile, spaceDir, spacesRoot, spacesRootAvailable } from '@mantle/files';
import { resolveStoragePath, tableDbRoot } from '@mantle/tabledb';
import { SPACE_ITEM_KINDS } from './member-space';
import { draftAbsFor, removeTableFile } from './table-storage';

/** Days a deactivated login's private items are kept before the purge. */
export const SPACE_PURGE_GRACE_DAYS = 30;

export type SpacePurgeCandidate = {
  spaceId: string;
  /** Private items that would be deleted. */
  items: number;
};

export type SpacePurgeResult = {
  /** Spaces that had private items to delete. */
  spaces: number;
  /** Items deleted. */
  items: number;
  /** Spaces left empty, whose directories were removed. */
  emptied: number;
  /** Why nothing ran, when nothing could. */
  skipped?: string;
};

/** Personal spaces whose login has been deactivated for the grace period. */
async function dueSpaces(cutoff: Date): Promise<string[]> {
  const rows = await db
    .select({ id: spaces.id })
    .from(spaces)
    .innerJoin(authUsers, eq(authUsers.id, spaces.loginId))
    .where(
      and(
        eq(spaces.kind, 'personal'),
        isNotNull(authUsers.disabledAt),
        lte(authUsers.disabledAt, cutoff),
      ),
    );
  return rows.map((r) => r.id);
}

/** The private items of one space: no state row (an old item), or private
 *  and neither submitted nor accepted. */
function privateItems(spaceId: string) {
  return and(
    eq(nodes.ownerId, spaceId),
    inArray(nodes.type, [...SPACE_ITEM_KINDS]),
    or(
      isNull(spaceItems.nodeId),
      and(
        eq(spaceItems.sharing, 'private'),
        notInArray(spaceItems.reviewState, ['submitted', 'accepted']),
      ),
    ),
  );
}

/** What the purge would delete now (the dry run). Counts only. */
export async function findSpacePurge(
  opts: { graceDays?: number; now?: Date } = {},
): Promise<SpacePurgeCandidate[]> {
  const cutoff = cutoffOf(opts);
  const out: SpacePurgeCandidate[] = [];
  for (const spaceId of await dueSpaces(cutoff)) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(nodes)
      .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .where(privateItems(spaceId));
    if (r?.n) out.push({ spaceId, items: r.n });
  }
  return out;
}

function cutoffOf(opts: { graceDays?: number; now?: Date }): Date {
  const days = opts.graceDays ?? SPACE_PURGE_GRACE_DAYS;
  return new Date((opts.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete the private items of every space whose login has been deactivated
 * for the grace period. One transaction per space; the bytes go after its
 * commit. Refuses to run where the spaces root is not mounted: rows without
 * their bytes removed would leave orphans nothing counts.
 */
export async function purgeDeactivatedSpaces(
  opts: { graceDays?: number; now?: Date } = {},
): Promise<SpacePurgeResult> {
  if (!spacesRootAvailable()) {
    return { spaces: 0, items: 0, emptied: 0, skipped: 'MANTLE_SPACES_ROOT is not set here' };
  }
  // A read-only mount (the events worker's) would delete rows and keep bytes.
  const writable = await access(spacesRoot(), constants.W_OK).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  );
  if (!writable) {
    return { spaces: 0, items: 0, emptied: 0, skipped: 'the spaces root is read-only here' };
  }
  const cutoff = cutoffOf(opts);
  const result: SpacePurgeResult = { spaces: 0, items: 0, emptied: 0 };
  for (const spaceId of await dueSpaces(cutoff)) {
    const after: (() => Promise<unknown> | unknown)[] = [];
    let deleted: { count: number; emptied: boolean };
    try {
      deleted = await db.transaction(async (tx) => {
        // One purge per space at a time (the cron and the CLI can overlap).
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`space-purge:${spaceId}`}, 0))`,
        );
        const doomed = await tx
          .select({ id: nodes.id, type: nodes.type, storagePath: tables.storagePath })
          .from(nodes)
          .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
          .leftJoin(tables, eq(tables.nodeId, nodes.id))
          .where(privateItems(spaceId));
        if (!doomed.length) return { count: 0, emptied: false };
        await tx.delete(nodes).where(
          inArray(
            nodes.id,
            doomed.map((d) => d.id),
          ),
        );
        const [left] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(nodes)
          .where(and(eq(nodes.ownerId, spaceId), ne(nodes.type, 'branch')));
        if ((left?.n ?? 0) === 0) {
          // Nothing left: the per-kind roots go too, and so do both directories.
          await tx.delete(nodes).where(eq(nodes.ownerId, spaceId));
          after.push(() => rm(spaceDir(spaceId), { recursive: true, force: true }));
          after.push(() => rm(path.join(tableDbRoot(), spaceId), { recursive: true, force: true }));
          return { count: doomed.length, emptied: true };
        }
        for (const d of doomed) {
          if (d.type === 'file') after.push(() => removeSpaceFile(spaceId, d.id));
          const sp = d.storagePath;
          if (sp) {
            after.push(() => {
              removeTableFile(draftAbsFor(sp));
              removeTableFile(resolveStoragePath(sp));
            });
          }
        }
        return { count: doomed.length, emptied: false };
      });
    } catch (err) {
      // One space failing leaves the rest to run; it is retried next night.
      console.error('[space-purge] a space failed:', err instanceof Error ? err.message : err);
      continue;
    }
    if (!deleted.count) continue;
    result.spaces++;
    result.items += deleted.count;
    if (deleted.emptied) result.emptied++;
    for (const fn of after) {
      try {
        await fn();
      } catch (err) {
        console.error(
          '[space-purge] removing bytes failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return result;
}
