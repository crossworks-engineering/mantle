/**
 * Whether a write needs its full-route spot (plan v3.2 S7b part b2 round 8,
 * the full audit's LOW 5: one helper instead of a predicate per caller).
 * The narrow login may write only its measured allowlist
 * (access-matrix.ts NARROW_WRITES); a write it may not make runs at the
 * caller's named spot (viewer.ts FULL_ROUTE_SPOTS). The caller names the
 * drizzle table and, for an UPDATE, the set it sends (its keys are the
 * table's property names; their column names are what Postgres checks).
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { narrowMayWrite } from './access-matrix';

export function narrowNeedsSpot(
  table: PgTable,
  op: 'insert' | 'update' | 'delete',
  set: Record<string, unknown> = {},
): boolean {
  const name = `${getTableConfig(table).schema ?? 'public'}.${getTableName(table)}`;
  const columns = getTableColumns(table) as Record<string, { name: string } | undefined>;
  const names = op === 'update' ? Object.keys(set).map((k) => columns[k]?.name ?? k) : [];
  return !narrowMayWrite(name, op, names);
}
