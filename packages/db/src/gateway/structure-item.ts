/**
 * The structure items an Admin area's narrow exit makes, edits and removes
 * (plan v3.2 S7b part b2): the Secrets root, a secret, a peer, a sender's
 * contact, a documentation item and the folders above one. One gateway for
 * the five writers that ran at a full-route spot before (secrets-root,
 * secret-item, peer-item, sender-contact, docs-collection).
 *
 * On the narrow route (narrowRouteNow: the switch on and the exit's pick)
 * each write is one call of the definer mantle_structure_item (migration
 * 0315), which holds the rule: a listed kind, from a system session, for the
 * acting login holding the kind's area. The narrow role holds no right on
 * nodes. Anywhere else (a login's scope, a full reason, the switch off) the
 * app's own statements run as they did, so every answer there is unchanged;
 * on the narrow route the definer does what those statements did (the same
 * row, heads and reset; structure-item.db.test.ts holds the two equal).
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { indexWorkFor, type IndexWork } from '@mantle/client-types/kinds';
import { RuntimeFaultError } from '@mantle/std';
import type * as schema from '../schema/index';
import { nodes, type Node } from '../schema/nodes';
import { markContentChanged } from '../content-changed';
import { actingLoginNow, currentCreateHome, currentSpaceScope } from '../viewer';
import { db } from './handles';
import { withNodeDeleteHeads, withNodeInsertHeads } from './heads';
import { narrowRouteNow } from './pools';
import { withSystemTx } from './system-tx';
import { uuidArrayLiteral } from './write-route';

type Tx = PostgresJsDatabase<typeof schema>;

/** The listed kinds, each with its item type (the definer's own list). */
export const STRUCTURE_KINDS = Object.freeze({
  'secrets-root': 'branch',
  'secret-item': 'secret',
  'peer-item': 'mantle_peer',
  'contact-item': 'contact',
  'docs-folder': 'branch',
  'docs-item': 'documentation',
} as const);

export type StructureKind = keyof typeof STRUCTURE_KINDS;

/** A new structure item's columns (owner, type and the rest come from the
 *  kind and the database's defaults). */
export type StructureInsert = {
  ownerId: string;
  title: string;
  slug?: string | null;
  path: string;
  data?: Record<string, unknown>;
  tags?: string[];
};

/** The definer, one call; its ids. */
async function callDefiner(
  q: Pick<Tx, 'execute'>,
  kind: StructureKind,
  op: 'insert' | 'update' | 'delete',
  ownerId: string,
  items: readonly string[] | null,
  fields: Record<string, unknown> | null,
): Promise<string[]> {
  const list: SQL =
    items === null ? sql`null` : sql`${uuidArrayLiteral(items, 'mantle_structure_item')}::uuid[]`;
  const rows = (await q.execute(
    sql`select x as id from mantle_structure_item(${kind}, ${op}, ${actingLoginNow()}::uuid,
          ${ownerId}::uuid, ${list}, ${fields === null ? null : JSON.stringify(fields)}::jsonb) x`,
  )) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Make one structure item with the heads of the folder it lands in, and run
 * `then` in the same transaction with its row (a secret's sealed value). A
 * branch kind already at its path makes nothing: null, `then` not run.
 * Wrap in withDeadlockRetry, as the heads helpers.
 */
export async function insertStructureItem(
  kind: StructureKind,
  values: StructureInsert,
  then?: (tx: Tx, row: Node) => Promise<void>,
): Promise<Node | null> {
  const type = STRUCTURE_KINDS[kind];
  const branch = type === 'branch';
  if (narrowRouteNow()) {
    return withSystemTx(async (tx) => {
      const fields: Record<string, unknown> = {
        title: values.title,
        slug: values.slug ?? null,
        path: values.path,
      };
      if (values.data !== undefined) fields.data = values.data;
      if (values.tags !== undefined) fields.tags = values.tags;
      const [id] = await callDefiner(tx, kind, 'insert', values.ownerId, null, fields);
      if (!id) return null;
      const [row] = await tx.select().from(nodes).where(eq(nodes.id, id));
      if (!row) throw new Error('insertStructureItem: the new row is not readable');
      if (then) await then(tx, row);
      return row;
    });
  }
  return withNodeInsertHeads(values.ownerId, [{ type, path: values.path }], async (tx) => {
    const insert = tx.insert(nodes).values({
      ownerId: values.ownerId,
      type,
      title: values.title,
      slug: values.slug ?? null,
      path: values.path,
      ...(values.data !== undefined ? { data: values.data } : {}),
      ...(values.tags !== undefined ? { tags: values.tags } : {}),
    });
    const [row] = branch
      ? await insert
          .onConflictDoNothing({
            target: [nodes.ownerId, nodes.path],
            where: sql`${nodes.type} = 'branch'`,
          })
          .returning()
      : await insert.returning();
    if (!row) {
      if (branch) return null;
      throw new Error('insertStructureItem: insert returned no row');
    }
    if (then) await then(tx, row);
    return row;
  });
}

/** The columns an edit sets: title and tags when given, data always. */
export type StructureUpdate = {
  title?: string;
  tags?: string[];
  data: Record<string, unknown>;
};

/**
 * Edit one structure item of the kind's type and reset its index for the
 * fields `changed` names (markContentChanged), in one transaction. Its row
 * after, or null when no such item.
 */
export async function updateStructureItem<K extends 'secret-item' | 'docs-item'>(
  kind: K,
  ownerId: string,
  id: string,
  set: StructureUpdate,
  changed: readonly string[],
): Promise<Node | null> {
  const type = STRUCTURE_KINDS[kind];
  if (narrowRouteNow()) {
    const work: IndexWork | null = indexWorkFor(type, changed);
    const fields: Record<string, unknown> = { data: set.data };
    if (set.title !== undefined) fields.title = set.title;
    if (set.tags !== undefined) fields.tags = set.tags;
    if (work === 'embed') {
      // Neither kind indexes a field for embed work only (the kind
      // registry): the definer resets for extract only.
      throw new RuntimeFaultError(`updateStructureItem: no embed reset for ${kind}`);
    }
    if (work) {
      fields.work = work;
      // markContentChanged's announcement: never for a personal item or a
      // quiet create.
      fields.announce = !currentSpaceScope() && !currentCreateHome()?.quiet;
    }
    return withSystemTx(async (tx) => {
      const [done] = await callDefiner(tx, kind, 'update', ownerId, [id], fields);
      if (!done) return null;
      const [row] = await tx.select().from(nodes).where(eq(nodes.id, done));
      return row ?? null;
    });
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodes)
      .set({
        ...(set.title !== undefined ? { title: set.title } : {}),
        ...(set.tags !== undefined ? { tags: set.tags } : {}),
        data: set.data,
        updatedAt: new Date(),
      })
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, type)))
      .returning();
    if (!row) return null;
    return (
      (await markContentChanged(
        tx,
        { id, type },
        changed as Parameters<typeof markContentChanged>[2],
      )) ?? row
    );
  });
}

/**
 * Remove structure items of the kind's type with the heads of each and of
 * its folder (withNodeDeleteHeads); their foreign keys cascade. The ids
 * removed. Wrap in withDeadlockRetry, as the heads helpers.
 */
export async function deleteStructureItems(
  kind: 'secret-item' | 'peer-item' | 'docs-item',
  ownerId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const type = STRUCTURE_KINDS[kind];
  if (narrowRouteNow()) {
    return withSystemTx((tx) => callDefiner(tx, kind, 'delete', ownerId, ids, null));
  }
  const rows = await withNodeDeleteHeads(ids, (tx) =>
    tx
      .delete(nodes)
      .where(and(inArray(nodes.id, [...ids]), eq(nodes.ownerId, ownerId), eq(nodes.type, type)))
      .returning({ id: nodes.id }),
  );
  return rows.map((r) => r.id);
}
