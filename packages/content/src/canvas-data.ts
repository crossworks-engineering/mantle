/**
 * The canvas data store (DWG phase 7a; the table: @mantle/db canvas_data,
 * migration 0336; the contract: @mantle/content-core/canvas-data). What a
 * Present canvas keeps through `mantle.data`, read and written for ONE login
 * on ONE canvas, both named by the caller (the route's session, an agent's
 * scope), never by the canvas.
 *
 * Rights, on the canvas's own item rights:
 *  - the canvas must be one the scope reads (a canvas it does not read is
 *    `missing`, whether it exists or not);
 *  - `shared`: every reader reads; a write asks Write on the canvas, the
 *    right a source save asks (itemWriteRefusalOf edit);
 *  - `mine`: a reader reads and writes their own login's entries; a login
 *    with Write on the canvas reads everyone's (`everyone`);
 *  - a read-only snapshot copy is never written.
 *
 * Reads run in the caller's scope, where the row rule (0336) holds the same
 * lines; the filters here say them again for unscoped work. Writes run on the
 * system pool after these checks (the access matrix's scopedSystemWrite, as
 * item_marks): the caps are counted over every row of the canvas in the same
 * statement, so a reader's scope, which sees only its own `mine` entries,
 * never decides them.
 *
 * Saving data is never a canvas revision: nothing here touches `presents`.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  canvasData,
  currentWorkspaceScope,
  db,
  isSnapshotCopy,
  itemWriteRefusalOf,
  nodes,
} from '@mantle/db';
import {
  CANVAS_DATA_CANVAS_MAX_BYTES,
  CANVAS_DATA_CANVAS_MAX_KEYS,
  CANVAS_DATA_FULL_ERROR,
  CANVAS_DATA_MINE_MAX_BYTES,
  CANVAS_DATA_MINE_MAX_KEYS,
  canvasDataValue,
  isCanvasDataBucket,
  isCanvasDataKey,
  type CanvasDataBucket,
  type CanvasDataEntry,
  type CanvasDataInfo,
} from '@mantle/content-core/canvas-data';

/** Who asks: the brain, and the login the entries are for (null: no login,
 *  system work, which reads `shared` only and writes nothing of `mine`). */
export type CanvasDataCaller = Readonly<{
  ownerId: string;
  loginId: string | null;
  /** The writer's display name, kept on what it writes. */
  name?: string | null;
}>;

/** Why a call was refused: the canvas is not one the scope reads (a 404),
 *  the scope reads it and may not do this (a 403), a write would pass a cap
 *  (a 413), or the request is not one the store takes (a 400). */
export type CanvasDataRefusal =
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'forbidden'; error: string }
  | { ok: false; reason: 'full'; error: string }
  | { ok: false; reason: 'invalid'; error: string };

const missing = { ok: false, reason: 'missing' } as const;
const invalid = (error: string) => ({ ok: false, reason: 'invalid', error }) as const;
const forbidden = (error: string) => ({ ok: false, reason: 'forbidden', error }) as const;

const NO_SHARED_WRITE =
  "only a user with Write on this canvas may change its shared data; save to 'mine' instead";
const NO_EVERYONE = "only a user with Write on this canvas reads everyone's entries";
const READ_ONLY = 'this canvas is a read-only copy: nothing is saved';
const NO_LOGIN = "'mine' needs a signed-in user";

type Canvas = { id: string; readOnly: boolean };

/** The canvas, read in the caller's scope; null when the scope does not
 *  read it (or there is no such canvas). */
async function canvasOf(ownerId: string, id: string): Promise<Canvas | null> {
  const [row] = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  return row ? { id: row.id, readOnly: isSnapshotCopy(row) } : null;
}

/** Whether the scope has Write on the canvas (outside a scope, system
 *  work: yes, as every item check). A read-only copy: no. */
async function writesCanvas(c: Canvas): Promise<boolean> {
  if (c.readOnly) return false;
  return (await itemWriteRefusalOf([c.id], 'edit')) === null;
}

function entryOf(r: {
  key: string;
  value: unknown;
  updatedAt: Date;
  updatedBy: string | null;
  loginId: string | null;
  byName: string | null;
}): CanvasDataEntry {
  const by = r.loginId ?? r.updatedBy;
  return {
    key: r.key,
    value: r.value,
    updatedAt: r.updatedAt.toISOString(),
    ...(by ? { by: { id: by, name: r.byName } } : {}),
  };
}

const entryColumns = {
  key: canvasData.key,
  value: canvasData.value,
  updatedAt: canvasData.updatedAt,
  updatedBy: canvasData.updatedBy,
  loginId: canvasData.loginId,
  byName: canvasData.byName,
};

/** What the store says about this reader of the canvas. */
export async function canvasDataInfo(
  caller: CanvasDataCaller,
  id: string,
): Promise<{ ok: true; info: CanvasDataInfo } | CanvasDataRefusal> {
  const c = await canvasOf(caller.ownerId, id);
  if (!c) return missing;
  const writes = await writesCanvas(c);
  return {
    ok: true,
    info: {
      canWriteShared: writes,
      readsEveryone: writes,
      me: caller.loginId,
      readOnly: c.readOnly,
    },
  };
}

/** The rows of one bucket the caller may read: `shared` whole, `mine` the
 *  caller's own (or everyone's, `everyone`, already allowed). */
function bucketWhere(
  id: string,
  bucket: CanvasDataBucket,
  loginId: string | null,
  everyone: boolean,
): SQL | undefined {
  const base = and(eq(canvasData.nodeId, id), eq(canvasData.bucket, bucket));
  if (bucket === 'shared' || everyone) return base;
  return and(base, loginId ? eq(canvasData.loginId, loginId) : sql`false`);
}

/** One entry, or null when there is none. */
export async function getCanvasData(
  caller: CanvasDataCaller,
  id: string,
  bucket: unknown,
  key: unknown,
): Promise<{ ok: true; entry: CanvasDataEntry | null } | CanvasDataRefusal> {
  if (!isCanvasDataBucket(bucket)) return invalid("bucket must be 'shared' or 'mine'");
  if (!isCanvasDataKey(key)) return invalid('key is not a valid key');
  const c = await canvasOf(caller.ownerId, id);
  if (!c) return missing;
  if (bucket === 'mine' && !caller.loginId) return invalid(NO_LOGIN);
  const [row] = await db
    .select(entryColumns)
    .from(canvasData)
    .where(and(bucketWhere(id, bucket, caller.loginId, false), eq(canvasData.key, key)))
    .limit(1);
  return { ok: true, entry: row ? entryOf(row) : null };
}

/** The entries of one bucket, oldest key first. `everyone` lists every
 *  login's `mine` entries: a user with Write on the canvas only. */
export async function listCanvasData(
  caller: CanvasDataCaller,
  id: string,
  bucket: unknown,
  opts: { everyone?: boolean } = {},
): Promise<{ ok: true; entries: CanvasDataEntry[] } | CanvasDataRefusal> {
  if (!isCanvasDataBucket(bucket)) return invalid("bucket must be 'shared' or 'mine'");
  const c = await canvasOf(caller.ownerId, id);
  if (!c) return missing;
  const everyone = bucket === 'mine' && opts.everyone === true;
  if (everyone && !(await writesCanvas(c))) return forbidden(NO_EVERYONE);
  if (bucket === 'mine' && !everyone && !caller.loginId) return invalid(NO_LOGIN);
  const rows = await db
    .select(entryColumns)
    .from(canvasData)
    .where(bucketWhere(id, bucket, caller.loginId, everyone))
    .orderBy(asc(canvasData.createdAt), asc(canvasData.key))
    .limit(CANVAS_DATA_CANVAS_MAX_KEYS);
  return { ok: true, entries: rows.map(entryOf) };
}

/** Who may write `bucket` on canvas `c`: null when the caller may. */
async function writeRefusal(
  caller: CanvasDataCaller,
  c: Canvas,
  bucket: CanvasDataBucket,
): Promise<CanvasDataRefusal | null> {
  if (c.readOnly) return forbidden(READ_ONLY);
  if (!caller.loginId) return invalid(NO_LOGIN);
  if (bucket === 'shared' && !(await writesCanvas(c))) return forbidden(NO_SHARED_WRITE);
  return null;
}

/**
 * Save one entry (made or replaced). The caps are checked in the insert's
 * own statement over every row of the canvas: nothing is written when the
 * canvas, or the caller's own `mine` entries, would pass one.
 */
export async function setCanvasData(
  caller: CanvasDataCaller,
  id: string,
  bucket: unknown,
  key: unknown,
  value: unknown,
): Promise<{ ok: true; updatedAt: string } | CanvasDataRefusal> {
  if (!isCanvasDataBucket(bucket)) return invalid("bucket must be 'shared' or 'mine'");
  if (!isCanvasDataKey(key)) return invalid('key is not a valid key');
  const checked = canvasDataValue(value);
  if (!checked.ok) return invalid(checked.error);
  const c = await canvasOf(caller.ownerId, id);
  if (!c) return missing;
  const refused = await writeRefusal(caller, c, bucket);
  if (refused) return refused;
  const me = caller.loginId!;
  const owner = bucket === 'mine' ? me : null;
  const name = (caller.name ?? '').trim().slice(0, 200) || null;

  // The row this write replaces, if any: left out of the sums.
  const other = sql`not (d.bucket = ${bucket} and d.key = ${key} and d.login_id is not distinct from ${owner}::uuid)`;
  const mineCaps =
    bucket === 'mine'
      ? sql` and (select coalesce(sum(d.bytes), 0) + ${checked.bytes}
                    from canvas_data d
                   where d.node_id = ${id}::uuid and d.bucket = 'mine'
                     and d.login_id = ${me}::uuid and ${other}) <= ${CANVAS_DATA_MINE_MAX_BYTES}
             and (select count(*) + 1
                    from canvas_data d
                   where d.node_id = ${id}::uuid and d.bucket = 'mine'
                     and d.login_id = ${me}::uuid and ${other}) <= ${CANVAS_DATA_MINE_MAX_KEYS}`
      : sql``;
  // Every column, in the table's order (an insert from a select names them
  // all): id, node_id, bucket, key, login_id, value, bytes, updated_by,
  // by_name, created_at, updated_at.
  const row = sql`select gen_random_uuid(), ${id}::uuid, ${bucket}, ${key}, ${owner}::uuid,
      ${checked.text}::jsonb, ${checked.bytes}::int, ${me}::uuid, ${name}, now(), now()
    where (select coalesce(sum(d.bytes), 0) + ${checked.bytes}
             from canvas_data d where d.node_id = ${id}::uuid and ${other}) <= ${CANVAS_DATA_CANVAS_MAX_BYTES}
      and (select count(*) + 1
             from canvas_data d where d.node_id = ${id}::uuid and ${other}) <= ${CANVAS_DATA_CANVAS_MAX_KEYS}${mineCaps}`;
  const set = {
    value: sql`excluded.value`,
    bytes: sql`excluded.bytes`,
    updatedBy: sql`excluded.updated_by`,
    byName: sql`excluded.by_name`,
    updatedAt: sql`now()`,
  };
  const insert = db.insert(canvasData).select(row);
  const saved = await (
    bucket === 'shared'
      ? insert.onConflictDoUpdate({
          target: [canvasData.nodeId, canvasData.key],
          targetWhere: sql`bucket = 'shared'`,
          set,
        })
      : insert.onConflictDoUpdate({
          target: [canvasData.nodeId, canvasData.loginId, canvasData.key],
          targetWhere: sql`bucket = 'mine'`,
          set,
        })
  ).returning({ updatedAt: canvasData.updatedAt });
  const done = saved[0];
  if (!done) return { ok: false, reason: 'full', error: CANVAS_DATA_FULL_ERROR };
  return { ok: true, updatedAt: done.updatedAt.toISOString() };
}

/** Remove one entry: `shared` with Write on the canvas, `mine` the caller's
 *  own only. `deleted` false when there was none. */
export async function deleteCanvasData(
  caller: CanvasDataCaller,
  id: string,
  bucket: unknown,
  key: unknown,
): Promise<{ ok: true; deleted: boolean } | CanvasDataRefusal> {
  if (!isCanvasDataBucket(bucket)) return invalid("bucket must be 'shared' or 'mine'");
  if (!isCanvasDataKey(key)) return invalid('key is not a valid key');
  const c = await canvasOf(caller.ownerId, id);
  if (!c) return missing;
  const refused = await writeRefusal(caller, c, bucket);
  if (refused) return refused;
  const gone = await db
    .delete(canvasData)
    .where(
      and(
        eq(canvasData.nodeId, id),
        eq(canvasData.bucket, bucket),
        eq(canvasData.key, key),
        bucket === 'mine'
          ? eq(canvasData.loginId, caller.loginId!)
          : sql`${canvasData.loginId} is null`,
      ),
    )
    .returning({ id: canvasData.id });
  return { ok: true, deleted: gone.length > 0 };
}

/**
 * Everything the caller may read of a canvas's data, for an agent (the
 * present tools): `shared`, the caller's own `mine`, and, with Write on the
 * canvas, everyone's `mine` entries. Null when the scope does not read the
 * canvas. The login is the scope's (an agent's turn answers its user).
 */
export async function readCanvasDataFor(
  ownerId: string,
  id: string,
): Promise<{
  shared: CanvasDataEntry[];
  mine: CanvasDataEntry[];
  everyone?: CanvasDataEntry[];
} | null> {
  const caller: CanvasDataCaller = {
    ownerId,
    loginId: currentWorkspaceScope()?.loginId ?? null,
  };
  const shared = await listCanvasData(caller, id, 'shared');
  if (!shared.ok) return null;
  const everyone = await listCanvasData(caller, id, 'mine', { everyone: true });
  if (everyone.ok) {
    return {
      shared: shared.entries,
      mine: everyone.entries.filter((e) => caller.loginId && e.by?.id === caller.loginId),
      everyone: everyone.entries,
    };
  }
  const mine = caller.loginId ? await listCanvasData(caller, id, 'mine') : null;
  return { shared: shared.entries, mine: mine?.ok ? mine.entries : [] };
}
