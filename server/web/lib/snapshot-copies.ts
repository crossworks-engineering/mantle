/**
 * The author's read-only snapshot copies of accepted items (workspaces W6b,
 * plan S3 and 21.8 row 17). An accepted item is a brain item already: its
 * author read only the ACCEPTED version, redacted at its level
 * (member-accepted.ts). The spaces fold (0267) left those reads on the
 * accepted space_items rows; this makes the copy that replaces them, for
 * exactly the homes with space_item_homes.snapshot (an accepted item homed
 * in a private or Former user workspace, W5c contract), then archives the
 * accepted rows away.
 *
 * Each copy: a new item of the same kind in that home (its only grant, Write
 * off), made from the accepted snapshot run through today's redactors (the
 * author's reader level; a login that is gone reads nothing beyond the item),
 * marked data.snapshot_of = the brain item and data.extract_skipped (reason
 * 'snapshot_copy'). No extractor notify (a quiet create), no LLM work, no
 * queue row. A drawing's element links are dropped (its picture keeps its
 * look); a table copies its first tab; a file the brain changed since its
 * accept has no accepted bytes left and gets no copy (counted).
 *
 * Idempotent: a home whose copy exists is skipped. Runs at boot after the
 * workspaces migration and by hand (pnpm maintain snapshot-copies). Never on
 * a cron or a trigger.
 *
 * One run at a time (W6b fix round 1, M4): the whole run holds a
 * transaction-level advisory lock on its own connection, so the boot step
 * and the maintenance task never make the same copy twice (the second waits,
 * then finds every copy made). Each copy is stamped in its own insert
 * (data.snapshot_of and extract_skipped, the create stamp of 0267), so no
 * copy is ever seen unstamped, and a copy whose snapshot_node_id write was
 * lost (a crash between the two) is found again by its snapshot_of.
 */
import { sql } from 'drizzle-orm';
import { asSystem, db, withCreateHome } from '@mantle/db';
import {
  acceptedItemForCopy,
  createDraw,
  createNote,
  createPage,
  createTable,
} from '@mantle/content';
import { copyFileById } from '@mantle/files';
import { forAcceptedKind } from '@mantle/client-types/kind-lists';

export type SnapshotCopyReport = {
  /** Homes that want a copy (snapshot = true). */
  wanted: number;
  /** Copies made by this run. */
  made: number;
  /** Copies that already existed. */
  already: number;
  /** No copy, by reason (the item or its snapshot is gone, a changed file). */
  skipped: Record<string, number>;
  /** Accepted space_items rows archived away after the copies. */
  acceptedRowsCleared: number;
};

type HomeRow = {
  node_id: string;
  home: string;
  copy: string | null;
  copy_exists: boolean;
  author: string | null;
  type: string;
};

/** Make every missing copy; `dryRun` counts only. Numbers only. */
export async function makeSnapshotCopies(
  opts: { dryRun?: boolean } = {},
): Promise<SnapshotCopyReport> {
  return asSystem(
    () =>
      db.transaction(async (lock) => {
        await lock.execute(sql`select pg_advisory_xact_lock(hashtext('mantle_snapshot_copies'))`);
        return makeSnapshotCopiesLocked(opts);
      }),
    'snapshot-copies',
  );
}

async function makeSnapshotCopiesLocked(opts: { dryRun?: boolean }): Promise<SnapshotCopyReport> {
  const report: SnapshotCopyReport = {
    wanted: 0,
    made: 0,
    already: 0,
    skipped: {},
    acceptedRowsCleared: 0,
  };
  const [b] = (await db.execute(
    sql`select "public"."mantle_brain_id"()::text as brain,
               to_regclass('public.space_fold_items') is not null
                 and "public"."mantle_ws_skip_reason"() is null
                 and exists (select 1 from workspaces w
                              where w.owner_id = "public"."mantle_brain_id"() and w.is_admin)
                 as folded`,
  )) as unknown as { brain: string | null; folded: boolean }[];
  const brain = b?.brain ?? null;
  if (!brain || !b?.folded) return report;
  const rows = (await db.execute(sql`
    select h.node_id::text as node_id, h.home_workspace_id::text as home,
           h.snapshot_node_id::text as copy,
           exists (select 1 from nodes c where c.id = h.snapshot_node_id) as copy_exists,
           coalesce(si.author_login_id, a.author_login_id)::text as author,
           coalesce(n.type::text, '') as type
      from space_item_homes h
      left join nodes n on n.id = h.node_id
      left join space_items si on si.node_id = h.node_id
      left join archive_space_items a on a.node_id = h.node_id
     where h.snapshot
     order by h.node_id`)) as unknown as HomeRow[];
  report.wanted = rows.length;
  const skip = (why: string) => (report.skipped[why] = (report.skipped[why] ?? 0) + 1);
  for (const r of rows) {
    if (r.copy && r.copy_exists) {
      report.already += 1;
      continue;
    }
    // Made before, its record lost: found by its stamp, recorded now.
    const stamped = (await db.execute(sql`
      select n.id::text as id from nodes n
       where n.owner_id = ${brain}::uuid and n.data->>'snapshot_of' = ${r.node_id}
         and n.home_ws = ${r.home}::uuid
       order by n.created_at limit 1`)) as unknown as { id: string }[];
    if (stamped[0]) {
      if (!opts.dryRun) {
        await db.execute(
          sql`update space_item_homes set snapshot_node_id = ${stamped[0].id}::uuid where node_id = ${r.node_id}::uuid`,
        );
      }
      report.already += 1;
      continue;
    }
    if (opts.dryRun) {
      skip('dry run: to make');
      continue;
    }
    // A login that is gone (deleted, or never in auth.users now) reads
    // nothing beyond the item.
    const author = r.author ? await liveLogin(r.author) : null;
    const found = await acceptedItemForCopy(brain, author, r.node_id);
    if (!found) {
      skip('item or snapshot gone');
      continue;
    }
    const copyId = await makeCopy(brain, r.home, found, {
      snapshot_of: r.node_id,
      extract_skipped: { reason: 'snapshot_copy', at: new Date().toISOString() },
    });
    if (!copyId) {
      skip(found.item.type === 'file' ? 'file changed since accepted' : 'kind not copied');
      continue;
    }
    await db.execute(
      sql`update space_item_homes set snapshot_node_id = ${copyId}::uuid where node_id = ${r.node_id}::uuid`,
    );
    report.made += 1;
  }
  if (opts.dryRun) return report;
  // Every wanted copy is there (or cannot be made): the accepted rows the
  // fold kept as the author read path go, archived first (0267 archived
  // every space_items row; this run's own check repeats it).
  const missing = rows.length - report.made - report.already;
  const unmakeable = Object.values(report.skipped).reduce((a, n) => a + n, 0);
  if (missing === unmakeable) {
    const gone = (await db.execute(sql`
      delete from space_items si
       where si.review_state = 'accepted'
         and exists (select 1 from archive_space_items a where a.node_id = si.node_id)
      returning si.node_id`)) as unknown as unknown[];
    report.acceptedRowsCleared = gone.length;
  }
  return report;
}

/** The login, while it exists. */
async function liveLogin(id: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`select id::text as id from auth.users where id = ${id}::uuid`,
  )) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

type Found = NonNullable<Awaited<ReturnType<typeof acceptedItemForCopy>>>;

/** The copy, made quietly in `home` and stamped in its insert; its id, or
 *  null for none. */
async function makeCopy(
  brain: string,
  home: string,
  found: Found,
  stamp: Record<string, unknown>,
): Promise<string | null> {
  const { item, snap } = found;
  const title = item.title;
  return withCreateHome({ createWs: home, privateWs: null, quiet: true, stamp }, async () => {
    // The one switch over an accepted item's kind (A10 #12).
    const made = forAcceptedKind<Found['item'], Promise<string | null>>(item, {
      page: async (page) =>
        (
          await createPage(brain, {
            title,
            doc: (page.doc ?? { type: 'doc', content: [] }) as Record<string, unknown>,
            ...(page.icon ? { icon: page.icon } : {}),
          })
        ).id,
      note: async (note) => (await createNote(brain, { title, content: note.content })).id,
      table: async (table) => (await createTable(brain, { title, data: table.table.data })).id,
      draw: async () => (await createDraw(brain, { title, scene: withoutLinks(snap.scene) })).id,
      file: async (file) => {
        if (file.changedByAdmin) return null;
        return copyFileUnderFreeName(brain, file.id, file.filename);
      },
    });
    return made ?? null;
  });
}

/** A drawing's scene with every element's link dropped: the copy keeps
 *  the picture, never a way into an item its reader may not open. */
function withoutLinks(scene: unknown): Record<string, unknown> | undefined {
  if (!scene || typeof scene !== 'object') return undefined;
  const s = scene as { elements?: unknown };
  const elements = Array.isArray(s.elements)
    ? s.elements.map((e) =>
        e && typeof e === 'object' ? { ...(e as Record<string, unknown>), link: null } : e,
      )
    : s.elements;
  return { ...(scene as Record<string, unknown>), elements };
}

/** The file copied into the files root as "<name> (accepted copy).<ext>",
 *  the first such name not taken there. */
async function copyFileUnderFreeName(
  brain: string,
  fileId: string,
  filename: string,
): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let i = 1; ; i++) {
    const name = `${stem} (accepted copy${i > 1 ? ` ${i}` : ''})${ext}`;
    try {
      return (await copyFileById({ ownerId: brain, fileId, destPath: 'files', newFilename: name }))
        .id;
    } catch (err) {
      if (i >= 50 || !/already exists/.test(err instanceof Error ? err.message : '')) throw err;
    }
  }
}
