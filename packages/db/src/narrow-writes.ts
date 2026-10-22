/**
 * Whether a write needs its full-route spot (plan v3.2 S7b part b2 round 8,
 * the full audit's LOW 5: one helper instead of a predicate per caller).
 * The narrow login may write only its measured allowlist
 * (access-matrix.ts NARROW_WRITES); a write it may not make runs at the
 * caller's named spot (viewer.ts FULL_ROUTE_SPOTS). The caller names the
 * drizzle table and, for an UPDATE, the set it sends (its keys are the
 * table's property names; their column names are what Postgres checks).
 *
 * Round 12: some rules hold a value, not a column (migration 0320): an
 * enable on the tables whose `enabled` the narrow role may only switch
 * off, and a heartbeat's resume or a next fire set by an edit (the
 * narrow role keeps a fire's books only one way). Such a set needs the
 * spot too (NARROW_VALUE_SPOTS).
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { narrowMayWrite } from './access-matrix';

/** Per table, the sets (property names and values) the narrow role's row
 *  rules refuse whatever its column rights (0320's mantle_narrow_one_way). */
export const NARROW_VALUE_SPOTS: Readonly<
  Record<string, (set: Record<string, unknown>) => boolean>
> = Object.freeze({
  'public.agents': (set) => set.enabled === true,
  'public.tool_groups': (set) => set.enabled === true,
  'public.channels': (set) => set.enabled === true,
  'public.telegram_accounts': (set) => set.enabled === true,
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
  if (op === 'update' && NARROW_VALUE_SPOTS[name]?.(set)) return true;
  return !narrowMayWrite(name, op, names);
}
