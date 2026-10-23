/**
 * The structure items an Admin area's narrow exit makes, edits and removes
 * (plan v3.2 S7b part b2): the Secrets root, a secret, a peer, a sender's
 * contact, a documentation item and the folders above one, and the events a
 * calendar synced (removed only). One gateway for the six writers that ran
 * at a full-route spot before (secrets-root, secret-item, peer-item,
 * sender-contact, docs-collection, calendar-events).
 *
 * On the narrow route (narrowRouteNow: the switch on and the exit's pick)
 * each write is one call of the definer mantle_structure_item (migration
 * 0316), which holds the rule: a listed kind, from a system session, for the
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
import { secrets } from '../schema/secrets';
import { markContentChanged } from '../content-changed';
import { actingLoginNow, currentCreateHome, currentSpaceScope, onFullSystemRoute } from '../viewer';
import { atActingLogin } from './acting-login';
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
  'calendar-event': 'event',
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

/**
 * The narrow route's transaction for a definer call: a system transaction
 * (withSystemTx), a savepoint of the one already open, at the acting-login
 * spot (atActingLogin: the definer needs the acting login, which the
 * identity readers answer only off the narrow role, 0322). The acting login
 * is passed to the definer, which also checks it against the setting the
 * gateway sends. Each caller below writes `atActingLogin((login) =>
 * withSystemTx(...))` in place, so what runs at the spot is read there.
 */

/**
 * Where a structure write runs: 'app' off the narrow route (the app's own
 * statements, as before); 'definer' on it when the exit acts for a login
 * (actingLoginNow: the request's login, or the login of the turn an
 * asSystem exit left, viewer.ts exitLogin); 'spot' on it with no login to
 * act for (a turn that answers no login, as a heartbeat's with the actor
 * check off): the app's own statements at the full-route spot
 * structure-no-login, as before this definer, since the definer takes only
 * an acting login.
 */
function structureRoute(): 'app' | 'definer' | 'spot' {
  if (!narrowRouteNow()) return 'app';
  return actingLoginNow() ? 'definer' : 'spot';
}

/** `fn` at the full-route spot structure-no-login when `route` says so. */
function onSpot<T>(route: 'app' | 'spot', fn: () => Promise<T>): Promise<T> {
  return route === 'spot' ? onFullSystemRoute('structure-no-login', fn) : fn();
}

/** The definer, one call; its ids. */
async function callDefiner(
  q: Pick<Tx, 'execute'>,
  login: string | null,
  kind: StructureKind,
  op: 'insert' | 'update' | 'delete',
  ownerId: string,
  items: readonly string[] | null,
  fields: Record<string, unknown> | null,
): Promise<string[]> {
  const list: SQL =
    items === null ? sql`null` : sql`${uuidArrayLiteral(items, 'mantle_structure_item')}::uuid[]`;
  const rows = (await q.execute(
    sql`select x as id from mantle_structure_item(${kind}, ${op}, ${login}::uuid,
          ${ownerId}::uuid, ${list}, ${fields === null ? null : JSON.stringify(fields)}::jsonb) x`,
  )) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** A secret's sealed value for its new row (the row's id is the seal's
 *  associated data): data only, so no caller's statement runs at a spot. */
export type SealedFor = (row: Node) => { ciphertext: Buffer; keyVersion: number };

/**
 * Make one structure item with the heads of the folder it lands in, and
 * insert its sealed value in the same transaction when `sealed` is given (a
 * secret: its row in secrets). A branch kind already at its path makes
 * nothing: null, no sealed row. Wrap in withDeadlockRetry, as the heads
 * helpers. The sealed value is computed by the caller but written here:
 * the caller passes no statement into the acting-login spot.
 */
export async function insertStructureItem(
  kind: StructureKind,
  values: StructureInsert,
  sealed?: SealedFor,
): Promise<Node | null> {
  const then = sealed
    ? async (tx: Tx, row: Node) => {
        const s = sealed(row);
        await tx
          .insert(secrets)
          .values({ nodeId: row.id, ciphertext: s.ciphertext, keyVersion: s.keyVersion });
      }
    : undefined;
  const type = STRUCTURE_KINDS[kind];
  const branch = type === 'branch';
  const route = structureRoute();
  if (route === 'definer') {
    return atActingLogin((login) =>
      withSystemTx(async (tx) => {
        const fields: Record<string, unknown> = {
          title: values.title,
          slug: values.slug ?? null,
          path: values.path,
        };
        if (values.data !== undefined) fields.data = values.data;
        if (values.tags !== undefined) fields.tags = values.tags;
        const [id] = await callDefiner(tx, login, kind, 'insert', values.ownerId, null, fields);
        if (!id) return null;
        const [row] = await tx.select().from(nodes).where(eq(nodes.id, id));
        if (!row) throw new Error('insertStructureItem: the new row is not readable');
        if (then) await then(tx, row);
        return row;
      }),
    );
  }
  return onSpot(route, () =>
    withNodeInsertHeads(values.ownerId, [{ type, path: values.path }], async (tx) => {
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
    }),
  );
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
  const route = structureRoute();
  if (route === 'definer') {
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
    return atActingLogin((login) =>
      withSystemTx(async (tx) => {
        const [done] = await callDefiner(tx, login, kind, 'update', ownerId, [id], fields);
        if (!done) return null;
        const [row] = await tx.select().from(nodes).where(eq(nodes.id, done));
        return row ?? null;
      }),
    );
  }
  return onSpot(route, () =>
    db.transaction(async (tx) => {
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
    }),
  );
}

/**
 * Remove structure items of the kind's type with the heads of each and of
 * its folder (withNodeDeleteHeads); their foreign keys cascade. `match`
 * (string values) narrows the rows to those whose data still holds it, read
 * again under the heads on both routes: the account a calendar's events
 * came from, the collection a purge removes (an item edited between the
 * read of the ids and the delete is left). The ids removed. Wrap in
 * withDeadlockRetry, as the heads helpers.
 */
export async function deleteStructureItems(
  kind: 'secret-item' | 'peer-item' | 'docs-item' | 'calendar-event',
  ownerId: string,
  ids: readonly string[],
  match?: Readonly<Record<string, string>>,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const type = STRUCTURE_KINDS[kind];
  const route = structureRoute();
  if (route === 'definer') {
    return atActingLogin((login) =>
      withSystemTx((tx) =>
        callDefiner(tx, login, kind, 'delete', ownerId, ids, match ? { match } : null),
      ),
    );
  }
  return onSpot(route, async () => {
    const rows = await withNodeDeleteHeads(ids, (tx) =>
      tx
        .delete(nodes)
        .where(
          and(
            inArray(nodes.id, [...ids]),
            eq(nodes.ownerId, ownerId),
            eq(nodes.type, type),
            ...(match ? [sql`${nodes.data} @> ${JSON.stringify(match)}::jsonb`] : []),
          ),
        )
        .returning({ id: nodes.id }),
    );
    return rows.map((r) => r.id);
  });
}
