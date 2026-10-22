/**
 * The heads: withHeads and its family (a subtree, an insert, a move, a
 * delete, a writer that changes a level or an embed, more heads later in
 * the same transaction), the personal-space exemptions (headsOrSpace,
 * withSpaceRows, onSpaceRows) and withDeadlockRetry, the one retry of a
 * whole transaction.
 */
import { sql as sqlTag } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../schema/index';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { currentScopeTx, currentSpaceScope, currentSystemTx } from '../viewer';
import { pgErrorCode } from '../pg-error';
import { getAdminDb } from './pools';
import { uuidArrayLiteral } from './write-route';
import { withSystemTx } from './system-tx';
import { getDb } from './scope';

/**
 * Run `fn` in ONE admin-pool transaction whose FIRST lock is the heads of
 * `ids` (workspaces plan U1 and V2): every writer of nodes, chunks, windows,
 * facts and grants goes through here, so no two writers can deadlock and none
 * can miss another's grant change. `update` for a change of grants, a move, a
 * delete or a chunk rewrite; `share` for a new item in a folder (lock the
 * folder). The database checks it (mantle.heads_check: off, warn, on).
 */
export async function withHeads<T>(
  ids: readonly string[],
  mode: 'update' | 'share',
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const list = uuidArrayLiteral(ids, 'withHeads');
  // Nested in a system transaction (arch A2b, plan 20.2): the database
  // decides (mantle_lock_heads_nested, 0277): more heads where it holds
  // some (FOR UPDATE NOWAIT; a busy one fails with 55P03 and the outermost
  // call retries), else the first lock with its rules. Never a second
  // first lock.
  const nested = currentSystemTx() !== null;
  return withSystemTx(async (tx) => {
    if (nested) await tx.execute(sqlTag`select mantle_lock_heads_nested(${list}::uuid[], ${mode})`);
    else await tx.execute(sqlTag`select mantle_lock_heads(${list}::uuid[], ${mode})`);
    return fn(tx);
  });
}

/**
 * withHeads for a whole subtree (plan U2, V1, V3): the heads of `root` and
 * everything under it (a folder), plus `extra` (a move's old and new
 * folder), locked FIRST; later rounds pick up rows that arrived while the
 * first round waited, without waiting. For a folder's grant change and for a
 * move. A busy later round fails with 55P03: wrap in withDeadlockRetry.
 */
export async function withSubtreeHeads<T>(
  root: string,
  extra: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(root)) throw new Error('withSubtreeHeads: root must be a uuid');
  const list = uuidArrayLiteral(extra, 'withSubtreeHeads');
  return withSystemTx(async (tx) => {
    // A first lock: nested in a transaction that holds heads, the database
    // refuses it (55000, mantle_lock_heads); lock the subtree in the
    // outermost call (arch A2b, plan 20.2).
    await tx.execute(sqlTag`select mantle_lock_subtree_heads(${root}::uuid, ${list}::uuid[])`);
    return fn(tx);
  });
}

/** The open system transaction (it sees its own rows), else the system
 *  pool: where a heads helper reads which heads to take (arch A2b). */
function systemTxOrPool(): PostgresJsDatabase<typeof schema> {
  return (currentSystemTx()?.tx as PostgresJsDatabase<typeof schema> | undefined) ?? getAdminDb();
}

/** The folders `items` would sit in (an item's path is its folder's path; a
 *  folder's parent is one level up). Read on the admin pool BEFORE the
 *  transaction, so the heads can still be its first lock. */
export async function folderHeadIds(
  ownerId: string,
  items: readonly { type: string; path: string }[],
): Promise<string[]> {
  if (!UUID_RE.test(ownerId)) throw new Error('folderHeadIds: ownerId must be a uuid');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = `${it.type}\u0000${it.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = (await systemTxOrPool().execute(
      sqlTag`select mantle_parent_folder(${ownerId}::uuid, ${it.type}::node_type, ${it.path}::ltree) as id`,
    )) as unknown as { id: string | null }[];
    const id = rows[0]?.id;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Heads for creating nodes (plan U1): the folders they land in, SHARE (many
 * creators may add to one folder at once; a grant change on the folder
 * waits for them, or they for it).
 */
export async function withNodeInsertHeads<T>(
  ownerId: string,
  items: readonly { type: string; path: string }[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  return withHeads(await folderHeadIds(ownerId, items), 'share', fn);
}

/**
 * Heads for moving one node (a path change, plan V3): the node and, for a
 * folder, everything under it, plus its old folder and the folder at
 * `newPath`, in rounds until stable.
 */
export async function withNodeMoveHeads<T>(
  ownerId: string,
  node: { id: string; type: string; path: string },
  newPath: string,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const folders = await folderHeadIds(ownerId, [
    { type: node.type, path: node.path },
    { type: node.type, path: newPath },
  ]);
  return withSubtreeHeads(node.id, folders, fn);
}

/**
 * Heads for deleting nodes (plan V4): each node, everything under a folder,
 * and the folders they sit in, UPDATE. Read before the transaction.
 */
export async function withNodeDeleteHeads<T>(
  ids: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const list = uuidArrayLiteral(ids, 'withNodeDeleteHeads');
  const rows = (await systemTxOrPool().execute(
    sqlTag`select distinct x.id from (
             select d.id from nodes n
               join nodes d on d.owner_id = n.owner_id
                and (d.id = n.id or (n.type = 'branch' and d.path <@ n.path))
              where n.id = any(${list}::uuid[])
             union
             select mantle_parent_folder(n.owner_id, n.type, n.path) from nodes n
              where n.id = any(${list}::uuid[])
           ) x where x.id is not null`,
  )) as unknown as { id: string }[];
  return withHeads(
    rows.map((r) => r.id),
    'update',
    fn,
  );
}

/**
 * Heads for a writer that also runs inside a member's personal space: in the
 * brain, `open` takes the heads and runs `fn` in its transaction; inside a
 * personal-space scope (rows outside any workspace grant, on the space
 * role, where heads cannot be taken) `fn` runs on the scope's own
 * transaction. That second path is removed with personal spaces in W6b
 * (workspaces plan); it is the one sanctioned exemption.
 */
export async function headsOrSpace<T>(
  open: (fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>) => Promise<T>,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (currentSpaceScope()) return fn(getDb());
  return open(fn);
}

/**
 * A write of rows the CURRENT personal space owns, on the space's own
 * transaction (withSpace). The space role cannot take heads, and it needs
 * none: the database exempts rows a personal space owns from the heads
 * check, because no workspace reads them (migration 0244 refuses a grant on
 * one). Throws outside a personal-space scope, so it cannot carry a brain
 * write. Removed with personal spaces in W6b (W4 replaces the exemption
 * before it grants personal items).
 */
export async function withSpaceRows<T>(
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!currentSpaceScope()) {
    throw new RuntimeFaultError('withSpaceRows: only inside a personal-space scope (withSpace)');
  }
  return fn(getDb());
}

/**
 * Rows that personal spaces own, written on `q` (an open transaction or the
 * pool) outside a space scope: an admin's purge, a takeover between two
 * spaces, a brain folder rename carried into the members' drafts. Checks
 * first that every id in `spaceIds` is a personal space. The database
 * exempts those rows from the heads check (0244) and still checks any brain
 * row, so a brain write slipped in here is caught there. Removed with
 * personal spaces in W6b.
 */
export async function onSpaceRows<
  Q extends { execute: PostgresJsDatabase<typeof schema>['execute'] },
  T,
>(q: Q, spaceIds: string | readonly string[], fn: (q: Q) => Promise<T>): Promise<T> {
  const ids = typeof spaceIds === 'string' ? [spaceIds] : [...new Set(spaceIds)];
  const list = uuidArrayLiteral(ids, 'onSpaceRows');
  const rows = (await q.execute(
    sqlTag`select count(*)::int as n from spaces
            where id = any(${list}::uuid[]) and kind = 'personal'`,
  )) as unknown as { n: number }[];
  if ((rows[0]?.n ?? 0) !== ids.length) {
    throw new Error('onSpaceRows: every id must be a personal space');
  }
  return fn(q);
}

/**
 * Heads for a writer that changes an item's level or what it embeds (a level
 * set, a save that adds or drops an embed): the item's head (`ids`, for
 * update) FIRST, so the level bridge (0251) finds its writer holding heads
 * and takes the rows that follow from the change (embeds, inherited levels)
 * itself without waiting. The whole transaction is retried when a head was
 * busy (55P03) or a deadlock was broken.
 *
 * Inside a personal-space scope (withSpace) `fn` runs on the space's own
 * transaction (headsOrSpace: no heads there, rule 1 of 0244). Inside an open
 * system transaction (withSystemTx, withHeads) it runs on that transaction:
 * its heads are already first, and the bridge locks the rest.
 */
export async function withWriterHeads<T>(
  ids: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (currentSpaceScope() || currentScopeTx()) {
    // A savepoint of the open transaction, as db.transaction is there.
    return getDb().transaction((tx) => fn(tx as unknown as PostgresJsDatabase<typeof schema>));
  }
  return withDeadlockRetry(() => withHeads(ids, 'update', fn));
}

/**
 * Lock more heads later in a heads transaction (plan U2, V1): FOR UPDATE
 * NOWAIT, for rows found only after the first lock (a bundle, the folders an
 * Accept lands in). A busy head fails with 55P03: run the whole transaction
 * in withDeadlockRetry.
 */
export async function lockMoreHeads(
  tx: { execute: PostgresJsDatabase<typeof schema>['execute'] },
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const list = uuidArrayLiteral(ids, 'lockMoreHeads');
  await tx.execute(sqlTag`select mantle_lock_heads_more(${list}::uuid[])`);
}

/** SQLSTATEs a whole transaction may be retried for: a deadlock, a
 *  serialization failure (a head missing in 'on' mode, a growing subtree), a
 *  NOWAIT lock that was busy. */
const RETRYABLE = new Set(['40P01', '40001', '55P03']);

/** The SQLSTATE on the error or its cause chain: pg-error.ts pgErrorCode,
 *  the one walk (round 13b: two walkers had grown apart). */
export function sqlState(err: unknown): string | null {
  return pgErrorCode(err);
}

/**
 * Run a whole transaction again when it failed for a retryable reason
 * (plan V1: every retry is at the caller, never inside a function). `run`
 * must start its own transaction each time (withHeads, withScope,
 * withSystemTx), so nothing of a failed attempt survives.
 */
export async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  // Inside an open system transaction (arch A2b, plan 20.2) a retry cannot
  // start afresh: the error goes to the outermost call, which retries.
  if (currentSystemTx()) return run();
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const code = sqlState(err);
      if (attempt >= attempts || code === null || !RETRYABLE.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 15 * attempt + Math.random() * 40 * attempt));
    }
  }
}
