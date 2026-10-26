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
 *    with Write on the canvas reads everyone's (`everyone`), removes any of
 *    them and clears the canvas's data (moderation);
 *  - a `shared` entry names its writer to every reader, and gives the
 *    writer's login id only to a login with Write on the canvas;
 *  - a read-only snapshot copy is never written.
 *
 * Reads run in the caller's scope, where the row rule (0336) holds the same
 * lines; the filters here say them again for unscoped work. Writes are the
 * two definers of 0336 (mantle_canvas_data_put and _delete), called in the
 * caller's own scope: they take the login from the scope, check the canvas's
 * rights and the caps under a lock on the canvas, and are the table's only
 * writers (no role writes it itself).
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
import { UUID_RE } from '@mantle/std';
import {
  CANVAS_DATA_CANVAS_MAX_KEYS,
  CANVAS_DATA_FULL_ERROR,
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
const NO_MODERATE = "only a user with Write on this canvas removes another viewer's entries";
const NO_CLEAR = 'only a user with Write on this canvas clears its data';
const READ_ONLY = 'this canvas is a read-only copy: nothing is saved';
const READ_ONLY_CALLER = 'this sign-in is read only: nothing is saved';
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

/** An entry as the reader sees it: a `shared` entry's writer by name, and
 *  by login id only for a reader with Write on the canvas (`showsIds`). */
function entryOf(
  r: {
    key: string;
    value: unknown;
    updatedAt: Date;
    updatedBy: string | null;
    loginId: string | null;
    byName: string | null;
  },
  showsIds: boolean,
): CanvasDataEntry {
  const by = r.loginId ?? r.updatedBy;
  const showId = r.loginId !== null || showsIds;
  return {
    key: r.key,
    value: r.value,
    updatedAt: r.updatedAt.toISOString(),
    ...(by ? { by: showId ? { id: by, name: r.byName } : { name: r.byName } } : {}),
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
  if (!row) return { ok: true, entry: null };
  return { ok: true, entry: entryOf(row, bucket === 'shared' && (await writesCanvas(c))) };
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
  const writes = bucket === 'shared' || everyone ? await writesCanvas(c) : false;
  if (everyone && !writes) return forbidden(NO_EVERYONE);
  if (bucket === 'mine' && !everyone && !caller.loginId) return invalid(NO_LOGIN);
  const rows = await db
    .select(entryColumns)
    .from(canvasData)
    .where(bucketWhere(id, bucket, caller.loginId, everyone))
    .orderBy(asc(canvasData.createdAt), asc(canvasData.key))
    .limit(CANVAS_DATA_CANVAS_MAX_KEYS);
  return { ok: true, entries: rows.map((r) => entryOf(r, writes)) };
}

/** What a definer answered (0336): 'ok', or why not. */
type DefinerResult = 'ok' | 'missing' | 'forbidden' | 'read_only' | 'ro' | 'full' | 'invalid';

/** The refusal for a definer's answer; `forbiddenWords` says what needed
 *  Write. */
function refusalOf(result: DefinerResult, forbiddenWords: string): CanvasDataRefusal {
  switch (result) {
    case 'missing':
      return missing;
    case 'forbidden':
      return forbidden(forbiddenWords);
    case 'read_only':
      return forbidden(READ_ONLY);
    case 'ro':
      return forbidden(READ_ONLY_CALLER);
    case 'full':
      return { ok: false, reason: 'full', error: CANVAS_DATA_FULL_ERROR };
    default:
      return invalid('the canvas data store did not take this request');
  }
}

/** A write runs only in a login's own scope: its definer takes the login
 *  from there, never from an argument. */
function writeScopeRefusal(caller: CanvasDataCaller): CanvasDataRefusal | null {
  const scope = currentWorkspaceScope();
  if (!caller.loginId || !scope?.loginId || scope.loginId !== caller.loginId) {
    return invalid(NO_LOGIN);
  }
  return null;
}

/**
 * Save one entry (made or replaced), by its definer (mantle_canvas_data_put,
 * 0336) in the caller's own scope: the canvas's rights, the read-only copy
 * and the caps are decided there, under a lock on the canvas, so two writes
 * never both pass a cap and a canvas deleted meanwhile is `missing`.
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
  const noScope = writeScopeRefusal(caller);
  if (noScope) return noScope;
  // A write: its own transaction, in the login's scope (the write role for
  // a member, the system pool with the scope set for an Admin user).
  const [row] = await db.transaction(
    async (tx) =>
      (await tx.execute(
        sql`select result, saved_at from "public"."mantle_canvas_data_put"(${id}::uuid, ${bucket}, ${key}, ${checked.text})`,
      )) as unknown as { result: DefinerResult; saved_at: Date | string | null }[],
  );
  if (!row || row.result !== 'ok' || !row.saved_at) {
    return refusalOf(row?.result ?? 'invalid', NO_SHARED_WRITE);
  }
  return { ok: true, updatedAt: new Date(row.saved_at).toISOString() };
}

/** One call of the delete definer (mantle_canvas_data_delete, 0336). */
async function deleteRows(
  id: string,
  bucket: CanvasDataBucket | null,
  key: string | null,
  login: string | null,
): Promise<{ result: DefinerResult; removed: number }> {
  const [row] = await db.transaction(
    async (tx) =>
      (await tx.execute(
        sql`select result, removed from "public"."mantle_canvas_data_delete"(${id}::uuid, ${bucket}, ${key}, ${login}::uuid)`,
      )) as unknown as { result: DefinerResult; removed: number }[],
  );
  return row ?? { result: 'invalid', removed: 0 };
}

/** Remove one entry: `shared` with Write on the canvas; `mine` the caller's
 *  own, or, with Write on the canvas, another login's (`by`: its login id,
 *  moderation). `deleted` false when there was none. */
export async function deleteCanvasData(
  caller: CanvasDataCaller,
  id: string,
  bucket: unknown,
  key: unknown,
  opts: { by?: unknown } = {},
): Promise<{ ok: true; deleted: boolean } | CanvasDataRefusal> {
  if (!isCanvasDataBucket(bucket)) return invalid("bucket must be 'shared' or 'mine'");
  if (!isCanvasDataKey(key)) return invalid('key is not a valid key');
  const by = opts.by ?? null;
  if (by !== null && (typeof by !== 'string' || !UUID_RE.test(by) || bucket !== 'mine')) {
    return invalid("by must be a viewer's id, for the 'mine' bucket");
  }
  const noScope = writeScopeRefusal(caller);
  if (noScope) return noScope;
  const other = by !== null && by !== caller.loginId;
  const r = await deleteRows(id, bucket, key, by);
  if (r.result !== 'ok') {
    return refusalOf(
      r.result,
      bucket === 'shared' ? NO_SHARED_WRITE : other ? NO_MODERATE : NO_SHARED_WRITE,
    );
  }
  return { ok: true, deleted: r.removed > 0 };
}

/** Remove every entry of the canvas, both buckets, every login: Write on
 *  the canvas only. */
export async function clearCanvasData(
  caller: CanvasDataCaller,
  id: string,
): Promise<{ ok: true; removed: number } | CanvasDataRefusal> {
  const noScope = writeScopeRefusal(caller);
  if (noScope) return noScope;
  const r = await deleteRows(id, null, null, null);
  if (r.result !== 'ok') return refusalOf(r.result, NO_CLEAR);
  return { ok: true, removed: r.removed };
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
