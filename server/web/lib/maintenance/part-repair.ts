/**
 * Give old import tables and extracted images their file's home and grants,
 * by the worker's own step (@mantle/db copyFileRows). Before this they landed
 * in Admin (docs/workspaces.md, "Parts of a file").
 *
 * Worker-made, told from a user's copy: a table with the tag `auto-import`, a
 * file with the tag `extracted-image` and `data.sourceOrdinal`. Only the
 * worker's passes set these. A user who typed `auto-import` on table_from_file
 * looks the same; the tool sets no tag of its own. A video's audio has neither.
 *
 * It changes an item only with the untouched Admin default: homed in Admin, no
 * person's name or Write on that row, no other row but an Admin one from its
 * folder, and a file with a live home that gives more than that default (a
 * file private to a login does). It leaves and counts the rest. Manual, dry run by default, never deletes, no
 * model call, ids and counts only.
 */
import { copyFileRows, db, liveWorkspaceSql, pgErrorCode, sql } from '@mantle/db';

export const PART_REPAIR_DEFAULT_LIMIT = 100;
export const PART_REPAIR_MAX_LIMIT = 1000;

export type OldPart = { id: string; type: string; fileId: string; ready: boolean; gone: boolean };

const READY = sql`f.id is not null and h.granted_by is null and not h.write
      and h.workspace_id = a.id
      and exists (select 1 from item_grants fh join workspaces w on w.id = fh.workspace_id
                   where fh.node_id = f.id and fh.is_home and ${liveWorkspaceSql('w')})
      and n.login_id is null
      and (f.login_id is not null
           or exists (select 1 from item_grants fg where fg.node_id = f.id and not fg.excluded
                       and not (fg.is_home and fg.workspace_id = a.id)))
      and not exists (select 1 from item_grants o where o.node_id = n.id and not o.is_home
                       and (o.via_folder_id is null or o.workspace_id <> a.id))`;

const FROM = sql`from nodes n
      join workspaces a on a.owner_id = n.owner_id and a.is_admin and ${liveWorkspaceSql('a')}
      left join item_grants h on h.node_id = n.id and h.is_home
      left join nodes f on f.id::text = n.data->>'sourceFileId' and f.type = 'file'`;

/** The old worker-made items. A repaired item is not ready again: it has another
 *  home, or a row of its file's. */
export async function findOldParts(): Promise<OldPart[]> {
  const rows = (await db.execute(sql`
    select n.id::text as id, n.type::text as type, n.data->>'sourceFileId' as file_id,
           f.id is null as gone, coalesce(${READY}, false) as ready
      ${FROM}
     where (n.type = 'table' and 'auto-import' = any(n.tags) and n.data ? 'sourceFileId')
        or (n.type = 'file' and 'extracted-image' = any(n.tags) and n.data ? 'sourceFileId'
            and n.data ? 'sourceOrdinal')
     order by n.created_at, n.id`)) as unknown as {
    id: string;
    type: string;
    file_id: string;
    ready: boolean;
    gone: boolean;
  }[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    fileId: r.file_id,
    ready: r.ready,
    gone: r.gone,
  }));
}

/** Give one item its file's rows, if it is still ready under its head. False
 *  when a person changed it since the read. */
export function repairOldPart(part: OldPart): Promise<boolean> {
  return copyFileRows(part.id, part.fileId, async (tx) => {
    const [row] = (await tx.execute(
      sql`select coalesce(${READY}, false) as ready ${FROM} where n.id = ${part.id}`,
    )) as unknown as { ready: boolean }[];
    return row?.ready === true;
  });
}

/** The flags, or null for a bad `--limit` (a bare one, or not a number: it must
 *  never fall to the default and change more than was asked). */
export function partRepairArgs(argv: readonly string[]): { apply: boolean; limit: number } | null {
  const raw = argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
  if (argv.includes('--limit') || (raw !== undefined && !(Number(raw) > 0))) return null;
  return { apply: argv.includes('--apply'), limit: raw ? Number(raw) : 0 };
}

/** One run. `log` gets ids and counts only. True when no item failed. */
export async function runPartRepair(
  opts: { apply: boolean; limit: number },
  log: (line: string) => void,
  repairOne: (part: OldPart) => Promise<boolean> = repairOldPart,
): Promise<boolean> {
  const rows = await findOldParts();
  const ready = rows.filter((r) => r.ready);
  const gone = rows.filter((r) => r.gone).length;
  log(
    `[part-repair] items: ${rows.length}. ready ${ready.length}, file deleted ${gone}, left alone ${rows.length - ready.length - gone}.`,
  );
  const limit = Math.min(
    opts.limit > 0 ? opts.limit : PART_REPAIR_DEFAULT_LIMIT,
    PART_REPAIR_MAX_LIMIT,
  );
  let changed = 0;
  let left = 0;
  let failed = 0;
  for (const r of ready.slice(0, limit)) {
    if (!opts.apply) {
      log(`  would change ${r.type} ${r.id} (file ${r.fileId})`);
      continue;
    }
    try {
      if (await repairOne(r)) {
        changed += 1;
        log(`  changed ${r.type} ${r.id}`);
      } else {
        left += 1;
        log(`  left ${r.type} ${r.id}: changed since the read`);
      }
    } catch (err) {
      failed += 1;
      log(`  failed ${r.type} ${r.id}: SQLSTATE ${pgErrorCode(err) ?? 'none'}`);
    }
  }
  log(
    opts.apply
      ? `[part-repair] changed ${changed}, left ${left}, failed ${failed}. Run again for the rest.`
      : `[part-repair] DRY RUN: nothing changed. --apply changes at most ${limit}.`,
  );
  return failed === 0;
}
