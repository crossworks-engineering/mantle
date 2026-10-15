/**
 * Recently deleted apps (apps first-class plan, Phase 3).
 *
 * Deleting an app takes a `pre_delete` snapshot first (apps.ts deleteApp):
 * the code, the name and look, and a copy of the database. Since migration
 * 0220 the app's history rows outlive the app, so for APP_TRASH_DAYS the app
 * can come back, with the same id (links and history line up again). After
 * that the nightly `app-trash-purge` sweep removes the rows and the files.
 *
 * Server-only (node:fs): import via '@mantle/content/app-trash'.
 */
import * as path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db, nodeSnapshots, nodes, type AppSnapshotCode } from '@mantle/db';
import {
  createApp,
  restoreAppDraft,
  restoreAppLive,
  setManifest,
  type AppHistoryActor,
} from './apps';
import { defineDomainError } from '@mantle/std';
import { tableDbRoot } from '@mantle/tabledb';
import { appDbRoot, restoreAppDatabaseFile } from './app-broker';
import { sweepCrashLeftovers } from './history-files';
import { dropUnfinishedApp } from './app-package';
import { notifyAppNavChanged } from './app-nav';

/** How long a deleted app can come back. */
export const APP_TRASH_DAYS = 30;

export type DeletedApp = {
  id: string;
  title: string;
  icon: string | null;
  color: string | null;
  deletedAt: string;
  /** Last day it can be restored; null when it waits for the brain's owner
   *  (deleted by another login, CEO decision 1: never purged by the sweep). */
  purgeAfter: string | null;
  hasData: boolean;
  dbBytes: number | null;
};

/** The app is still there, or its last snapshot is gone. */
export class AppTrashRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppTrashRefusedError';
  }
}

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): what
// the routes answered by hand.
defineDomainError(AppTrashRefusedError, {
  reason:
    'the app is not deleted, or its last snapshot cannot bring it back; the message says which',
  status: 409,
});

type DeletedRow = {
  node_id: string;
  /** Deleted by a login other than the brain's owner (CEO decision 1). */
  held: boolean;
  id: string;
  seq: number;
  created_at: Date | string;
  /** The whole code for a restore; only its `meta` for the list. */
  code: AppSnapshotCode | null;
  db_path: string | null;
  db_bytes: string | number | null;
  schema_version: number | null;
};

/** Each deleted app's newest pre_delete row (the app itself is gone). The
 *  list reads the name and look only, not every deleted app's whole code
 *  (apps audit 2026-10-02, low); a restore reads its one app's code. */
async function deletedRows(ownerId: string, appId?: string): Promise<DeletedRow[]> {
  const code = appId ? sql`s.code` : sql`jsonb_build_object('meta', s.code->'meta') as code`;
  const rows = (await db.execute(sql`
    select distinct on (s.node_id)
           s.node_id, s.id, s.seq, s.created_at, ${code}, s.db_path, s.db_bytes, s.schema_version,
           coalesce((s.code->'meta'->>'keepForOwner')::boolean, false) as held
      from node_snapshots s
     where s.owner_id = ${ownerId}
       and s.node_kind = 'app'
       and s.trigger = 'pre_delete'
       ${appId ? sql`and s.node_id = ${appId}` : sql``}
       and not exists (select 1 from nodes n where n.id = s.node_id)
     order by s.node_id, s.seq desc`)) as unknown as DeletedRow[];
  return rows;
}

const purgeAfterOf = (deletedAt: Date) =>
  new Date(deletedAt.getTime() + APP_TRASH_DAYS * 24 * 60 * 60 * 1000);

/** The owner's recently deleted apps, newest first. */
export async function listDeletedApps(ownerId: string): Promise<DeletedApp[]> {
  return deletedAppsOf(await deletedRows(ownerId));
}

/** Snapshot rows as the trash lists them: name, look, when, until when,
 *  its data; the purged ones left out, newest first. */
function deletedAppsOf(
  rows: Pick<DeletedRow, 'node_id' | 'held' | 'created_at' | 'code' | 'db_path' | 'db_bytes'>[],
): DeletedApp[] {
  const now = Date.now();
  return rows
    .map((r) => {
      const deletedAt = new Date(r.created_at);
      const meta = r.code?.meta;
      return {
        id: r.node_id,
        title: meta?.title ?? 'Untitled app',
        icon: meta?.icon ?? null,
        color: meta?.color ?? null,
        deletedAt: deletedAt.toISOString(),
        purgeAfter: r.held ? null : purgeAfterOf(deletedAt).toISOString(),
        hasData: r.db_path !== null,
        dbBytes: r.db_bytes === null ? null : Number(r.db_bytes),
      };
    })
    .filter((d) => d.purgeAfter === null || new Date(d.purgeAfter).getTime() > now)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * The deleted apps the caller may manage, with each one's home (W7b fix
 * round 1), by their definer (mantle_deleted_apps, 0293): a deleted app's
 * rows are gone, so a scope's row rule hides its snapshots (0265). In a
 * workspace scope only those homed in a workspace the scope moderates (the
 * anchor login: every workspace it moderates), or with no home for the
 * anchor login; with no scope, every one. A6b: the tools read the whole
 * trash on the system pool before ('app-trash') and filtered it here.
 */
export async function manageableDeletedApps(ownerId: string): Promise<{
  homes: Map<string, string | null>;
  apps: DeletedApp[];
}> {
  const rows = (await db.execute(
    sql`select id::text as node_id, home, created_at, meta as code, db_path, db_bytes, held
          from "public"."mantle_deleted_apps"(${ownerId}::uuid)`,
  )) as unknown as (Pick<
    DeletedRow,
    'node_id' | 'held' | 'created_at' | 'code' | 'db_path' | 'db_bytes'
  > & { home: string | null })[];
  return {
    homes: new Map(rows.map((r) => [r.node_id.toLowerCase(), r.home])),
    apps: deletedAppsOf(rows),
  };
}

/** Whether a member ever wrote this app's code (a history row by a member,
 *  team apps Phase 3). */
async function memberEra(appId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodeSnapshots.id })
    .from(nodeSnapshots)
    .where(and(eq(nodeSnapshots.nodeId, appId), eq(nodeSnapshots.actor, 'member')))
    .limit(1);
  return !!row;
}

/**
 * Bring a deleted app back from its last snapshot, with the same id: its
 * code (live, with the build it ran, when it had been published), its name
 * and look, and its data. Its sharing and its level do not come back: it
 * returns as an admin-only app in Unsorted.
 */
export async function restoreDeletedApp(
  ownerId: string,
  appId: string,
  opts: { actor?: AppHistoryActor } = {},
): Promise<{ id: string; title: string } | null> {
  const [row] = await deletedRows(ownerId, appId);
  if (!row) {
    const [live] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, appId))
      .limit(1);
    if (live) throw new AppTrashRefusedError(`app ${appId} is not deleted`);
    return null;
  }
  const code = row.code;
  if (!code) throw new AppTrashRefusedError(`the last snapshot of app ${appId} holds no code`);
  const meta = code.meta;
  // The node is made first, with the same id; if a later step fails, it goes
  // again and the app is back in the trash as it was (apps audit
  // 2026-10-02, low: an undelete was not all or nothing).
  const app = await createApp(ownerId, {
    id: appId,
    title: meta?.title ?? 'Restored app',
    ...(meta?.icon ? { icon: meta.icon } : {}),
    ...(meta?.color ? { color: meta.color as never } : {}),
    tags: meta?.tags ?? [],
    ...(code.manifest.description ? { description: code.manifest.description } : {}),
    source: code.source,
    // The author ceiling comes back too (team apps Phase 3, M3 audit): a
    // member-era app, or one that ran at team rules, stays at team rules.
    ...((await memberEra(appId)) || meta?.authorLevel === 'team'
      ? { authorLevel: 'team' as const }
      : {}),
  });
  try {
    if (row.db_path) {
      await restoreAppDatabaseFile(
        ownerId,
        app.id,
        path.resolve(appDbRoot(), row.db_path),
        row.schema_version ?? 0,
        { drainMs: 0 },
      );
    }
    const build = code.publishedBuild;
    if (build?.ok) {
      await restoreAppLive(ownerId, app.id, { ...code, publishedBuild: build }, row.seq, {
        discardDraft: true,
        actor: opts.actor ?? 'owner',
      });
    } else {
      await restoreAppDraft(ownerId, app.id, code, row.seq, { discardDraft: true });
      // The same app coming back: its own tools and schema with it (a draft
      // restore leaves the manifest alone, and createApp starts it empty).
      await setManifest(ownerId, app.id, code.manifest);
    }
  } catch (err) {
    // The history rows outlive the node: the app is in the trash again.
    await dropUnfinishedApp(ownerId, app.id);
    throw err;
  }
  void notifyAppNavChanged(ownerId);
  return { id: app.id, title: app.title };
}

/** Remove a deleted app's history rows. Their snapshot files are the store
 *  sweep's: each row's trigger records its file (store_tombstones, 0284),
 *  removed a grace period later while no row names it (A3b part 2). A
 *  member app moved to the brain keeps its member-era files where they
 *  were; they go the same way, by each row's own path. */
async function purgeOne(ownerId: string, appId: string): Promise<void> {
  await db
    .delete(nodeSnapshots)
    .where(and(eq(nodeSnapshots.ownerId, ownerId), eq(nodeSnapshots.nodeId, appId)));
}

/** Delete a deleted app for good, now. False when it is not in the trash.
 *  An app a login other than the brain's owner deleted is the owner's to
 *  purge (`byOwner`; CEO decision 1): refused for anyone else. */
export async function purgeDeletedApp(
  ownerId: string,
  appId: string,
  opts: { byOwner?: boolean } = {},
): Promise<boolean> {
  const [row] = await deletedRows(ownerId, appId);
  if (!row) return false;
  if (row.held && !opts.byOwner) {
    throw new AppTrashRefusedError(
      `app ${appId} was deleted by someone other than the brain owner: only the owner deletes it for good`,
    );
  }
  await purgeOne(ownerId, appId);
  return true;
}

/**
 * The nightly sweep (`app-trash-purge`): every owner's deleted apps past
 * APP_TRASH_DAYS, and any history whose app is gone without a pre_delete
 * row (an app deleted before Phase 3), once its newest row is that old.
 * Never an app whose newest pre_delete row says a login other than the
 * brain's owner deleted it (keepForOwner, CEO decision 1, W6b fix round 1):
 * the owner purges that one by hand. Plain SQL and file removal, no model.
 */
export async function purgeExpiredDeletedApps(
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<{ apps: number }> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - APP_TRASH_DAYS * 86_400_000);
  const rows = (await db.execute(sql`
    select s.owner_id, s.node_id
      from node_snapshots s
     where s.node_kind = 'app'
       and not exists (select 1 from nodes n where n.id = s.node_id)
       and not coalesce((select (k.code->'meta'->>'keepForOwner')::boolean
                           from node_snapshots k
                          where k.node_id = s.node_id and k.node_kind = 'app'
                            and k.trigger = 'pre_delete'
                          order by k.seq desc limit 1), false)
     group by s.owner_id, s.node_id
    having max(s.created_at) < ${cutoff.toISOString()}::timestamptz`)) as unknown as {
    owner_id: string;
    node_id: string;
  }[];
  if (opts.dryRun) return { apps: rows.length };
  for (const r of rows) await purgeOne(r.owner_id, r.node_id);
  return { apps: rows.length };
}

/** The work files crashes left in the app and table folders (a schema
 *  trial, a restore's temp file, a package work file), an hour old or more.
 *  Part of the nightly `app-trash-purge`. */
export async function sweepAppFileLeftovers(opts: { dryRun?: boolean } = {}): Promise<number> {
  return sweepCrashLeftovers([appDbRoot(), tableDbRoot()], opts);
}
