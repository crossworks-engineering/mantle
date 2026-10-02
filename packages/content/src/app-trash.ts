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
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db, nodeSnapshots, nodes, type AppSnapshotCode } from '@mantle/db';
import { createApp, restoreAppDraft, restoreAppLive, type AppHistoryActor } from './apps';
import { appDbRoot, restoreAppDatabaseFile } from './app-broker';
import { notifyAppNavChanged } from './app-nav';

/** How long a deleted app can come back. */
export const APP_TRASH_DAYS = 30;

export type DeletedApp = {
  id: string;
  title: string;
  icon: string | null;
  color: string | null;
  deletedAt: string;
  /** Last day it can be restored. */
  purgeAfter: string;
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

type DeletedRow = {
  node_id: string;
  id: string;
  seq: number;
  created_at: Date | string;
  code: AppSnapshotCode | null;
  db_path: string | null;
  db_bytes: string | number | null;
  schema_version: number | null;
};

/** Each deleted app's newest pre_delete row (the app itself is gone). */
async function deletedRows(ownerId: string, appId?: string): Promise<DeletedRow[]> {
  const rows = (await db.execute(sql`
    select distinct on (s.node_id)
           s.node_id, s.id, s.seq, s.created_at, s.code, s.db_path, s.db_bytes, s.schema_version
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
  const now = Date.now();
  return (await deletedRows(ownerId))
    .map((r) => {
      const deletedAt = new Date(r.created_at);
      const meta = r.code?.meta;
      return {
        id: r.node_id,
        title: meta?.title ?? 'Untitled app',
        icon: meta?.icon ?? null,
        color: meta?.color ?? null,
        deletedAt: deletedAt.toISOString(),
        purgeAfter: purgeAfterOf(deletedAt).toISOString(),
        hasData: r.db_path !== null,
        dbBytes: r.db_bytes === null ? null : Number(r.db_bytes),
      };
    })
    .filter((d) => new Date(d.purgeAfter).getTime() > now)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
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
  const app = await createApp(ownerId, {
    id: appId,
    title: meta?.title ?? 'Restored app',
    ...(meta?.icon ? { icon: meta.icon } : {}),
    ...(meta?.color ? { color: meta.color as never } : {}),
    tags: meta?.tags ?? [],
    ...(code.manifest.description ? { description: code.manifest.description } : {}),
    source: code.source,
  });
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
  }
  void notifyAppNavChanged(ownerId);
  return { id: app.id, title: app.title };
}

/** Remove a deleted app's history rows and snapshot files. */
async function purgeOne(ownerId: string, appId: string): Promise<void> {
  await db
    .delete(nodeSnapshots)
    .where(and(eq(nodeSnapshots.ownerId, ownerId), eq(nodeSnapshots.nodeId, appId)));
  await rm(path.join(appDbRoot(), '_snapshots', ownerId, appId), {
    recursive: true,
    force: true,
  });
}

/** Delete a deleted app for good, now. False when it is not in the trash. */
export async function purgeDeletedApp(ownerId: string, appId: string): Promise<boolean> {
  const [row] = await deletedRows(ownerId, appId);
  if (!row) return false;
  await purgeOne(ownerId, appId);
  return true;
}

/**
 * The nightly sweep (`app-trash-purge`): every owner's deleted apps past
 * APP_TRASH_DAYS, and any history whose app is gone without a pre_delete
 * row (an app deleted before Phase 3), once its newest row is that old.
 * Plain SQL and file removal, no model.
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
     group by s.owner_id, s.node_id
    having max(s.created_at) < ${cutoff.toISOString()}::timestamptz`)) as unknown as {
    owner_id: string;
    node_id: string;
  }[];
  if (opts.dryRun) return { apps: rows.length };
  for (const r of rows) await purgeOne(r.owner_id, r.node_id);
  return { apps: rows.length };
}
