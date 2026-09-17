/**
 * Schema drift guard (2026-09-02 audit, gap D2). The Drizzle schema in
 * src/schema/*.ts and the hand-written SQL in migrations/ are two descriptions
 * of the same database, and nothing compared them: migrations/meta/ holds
 * snapshots for 0000 and 0036 only, so `drizzle-kit generate/check` cannot
 * diff the rest, and the migrations were never replayed in CI at all.
 *
 * This test runs against a database that `init-scratch` + `migrate` just
 * built from 0000→latest (build-check provisions one; locally point
 * MANTLE_TEST_DATABASE_URL at any scratch db you migrated the same way) and
 * asserts, per Drizzle table (schema-qualified — auth.users is declared in
 * Drizzle but created by infra/postgres/init): the table exists, every Drizzle
 * column exists with the same NOT NULL-ness, and the live table carries no
 * column Drizzle does not know about. Skipped when the env var is absent,
 * like the runs engine suite.
 */
import { describe, expect, it } from 'vitest';
import { Table, getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type LiveColumn = { schema: string; table: string; column: string; nullable: boolean };

describe.skipIf(!URL)('drizzle schema matches the migrated database', () => {
  const tables = Object.values(schema).filter((v) => is(v, Table)) as unknown as PgTable[];

  it('finds the Drizzle tables to compare', () => {
    expect(tables.length).toBeGreaterThan(20);
  });

  it('every Drizzle table and column exists live, with matching nullability, and nothing extra', async () => {
    const sql = postgres(URL!, { max: 1, prepare: false });
    try {
      const rows = await sql<LiveColumn[]>`
        select table_schema as "schema", table_name as "table", column_name as "column",
               (is_nullable = 'YES') as nullable
        from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema', 'drizzle')
      `;
      const live = new Map<string, Map<string, boolean>>();
      for (const r of rows) {
        const key = `${r.schema}.${r.table}`;
        if (!live.has(key)) live.set(key, new Map());
        live.get(key)!.set(r.column, r.nullable);
      }

      const problems: string[] = [];
      for (const t of tables) {
        const cfg = getTableConfig(t);
        const name = `${cfg.schema ?? 'public'}.${cfg.name}`;
        const liveCols = live.get(name);
        if (!liveCols) {
          problems.push(`table "${name}" is in the Drizzle schema but not in the database`);
          continue;
        }
        const wanted = new Map<string, boolean>();
        for (const col of Object.values(getTableColumns(t))) {
          wanted.set(col.name, !col.notNull);
        }
        for (const [col, nullable] of wanted) {
          const liveNullable = liveCols.get(col);
          if (liveNullable === undefined) {
            problems.push(`"${name}"."${col}" is in the Drizzle schema but not in the database`);
          } else if (liveNullable !== nullable) {
            problems.push(
              `"${name}"."${col}" nullability differs: drizzle ${nullable ? 'NULL' : 'NOT NULL'}, database ${liveNullable ? 'NULL' : 'NOT NULL'}`,
            );
          }
        }
        for (const col of liveCols.keys()) {
          if (!wanted.has(col)) {
            problems.push(
              `"${name}"."${col}" exists in the database but not in the Drizzle schema`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
    } finally {
      await sql.end();
    }
  }, 60_000);
});
