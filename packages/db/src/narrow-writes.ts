/**
 * Whether a write needs its full-route spot (plan v3.2 S7b part b2 round 8,
 * the full audit's LOW 5: one helper instead of a predicate per caller).
 * The narrow login may write only its measured allowlist
 * (access-matrix.ts NARROW_WRITES); a write it may not make runs at the
 * caller's named spot (viewer.ts FULL_ROUTE_SPOTS). The caller names the
 * drizzle table and, for an UPDATE, the set it sends (its keys are the
 * table's property names; their column names are what Postgres checks).
 *
 * Some rules hold a value, not a column (migration 0320): an
 * enable on the tables whose `enabled` the narrow role may only switch
 * off, and a heartbeat's resume or a next fire set by an edit (the
 * narrow role keeps a fire's books only one way). Such a set needs the
 * spot too (NARROW_VALUE_SPOTS).
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { narrowMayWrite } from './access-matrix';

/** The switches the narrow role may only turn off, on every table that has
 *  one (0323, generated from the catalog by column name: enabled,
 *  is_default, backup_enabled), as drizzle property names: a set that turns
 *  one on needs the caller's spot. */
export const NARROW_OFF_ONLY_PROPS: readonly string[] = Object.freeze([
  'enabled',
  'isDefault',
  'backupEnabled',
]);

/** Whether `set` turns on a switch the narrow role may only turn off. */
export function turnsOn(set: Record<string, unknown>): boolean {
  return NARROW_OFF_ONLY_PROPS.some((p) => set[p] === true);
}

/** Whether an insert of `values` into `table` starts one of its off-only
 *  switches on: a value of true, or none and a column default of true. */
export function insertTurnsOn(table: PgTable, values: Record<string, unknown>): boolean {
  const columns = getTableColumns(table) as Record<
    string,
    { name: string; default?: unknown; columnType?: string } | undefined
  >;
  return NARROW_OFF_ONLY_PROPS.some((p) => {
    const col = columns[p];
    if (!col || col.columnType !== 'PgBoolean') return false;
    return p in values ? values[p] === true : col.default === true;
  });
}

/** Per table, the other sets (property names and values) the narrow role's
 *  row rules refuse whatever its column rights (0320's
 *  mantle_narrow_one_way); a turn-on is every table's (turnsOn). */
export const NARROW_VALUE_SPOTS: Readonly<
  Record<string, (set: Record<string, unknown>) => boolean>
> = Object.freeze({
  'public.heartbeats': (set) =>
    set.status === 'active' || (set.nextFireAt !== undefined && set.nextFireAt !== null),
});

export function narrowNeedsSpot(
  table: PgTable,
  op: 'insert' | 'update' | 'delete',
  set: Record<string, unknown> = {},
): boolean {
  const name = `${getTableConfig(table).schema ?? 'public'}.${getTableName(table)}`;
  const columns = getTableColumns(table) as Record<string, { name: string } | undefined>;
  const names = op === 'update' ? Object.keys(set).map((k) => columns[k]?.name ?? k) : [];
  if (op === 'update' && (turnsOn(set) || NARROW_VALUE_SPOTS[name]?.(set))) return true;
  // A new row that starts a switch on, named or by its column default
  // (0324: the off-only rule meets an INSERT too, so a delete and insert
  // again cannot turn one back on): the caller's spot. `set` is the
  // insert's values here.
  if (op === 'insert' && insertTurnsOn(table, set)) return true;
  return !narrowMayWrite(name, op, names);
}
