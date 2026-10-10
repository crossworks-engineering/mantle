/**
 * The drizzle schema of archive_node_levels (schema/archive/node-levels.ts)
 * is the table migration 0261 makes (CREATE TABLE AS SELECT from nodes:
 * the nodes column types, no NOT NULL but the primary key added after).
 * Each column's type (data_type and udt_name) and nullability, from
 * information_schema, against the drizzle columns; and the archived level
 * columns keep the type of the nodes columns they copy.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/archive-node-levels-schema.db.test.ts
 */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveNodeLevels } from './schema/archive/node-levels';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Col = { column_name: string; data_type: string; udt_name: string; is_nullable: string };

/** information_schema's data_type and udt_name for a drizzle SQL type. */
const PG_TYPES: Record<string, { data_type: string; udt_name: string }> = {
  uuid: { data_type: 'uuid', udt_name: 'uuid' },
  text: { data_type: 'text', udt_name: 'text' },
  'timestamp with time zone': { data_type: 'timestamp with time zone', udt_name: 'timestamptz' },
};

describe.skipIf(!URL)('archive_node_levels: the drizzle schema is the table 0261 makes', () => {
  type Db = typeof import('./index');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
  }, 60_000);

  afterAll(async () => {
    await m?.closeDb();
  });

  const columns = async (table: string): Promise<Col[]> =>
    (await admin`select column_name, data_type, udt_name, is_nullable
                   from information_schema.columns
                  where table_schema = 'public' and table_name = ${table}
                  order by ordinal_position`) as unknown as Col[];

  it('every column: name, type and nullability', async () => {
    const config = getTableConfig(archiveNodeLevels);
    const expected = config.columns.map((c) => {
      const type = PG_TYPES[c.getSQLType()];
      expect(type, `${c.name}: ${c.getSQLType()} has a mapping`).toBeDefined();
      return {
        column_name: c.name,
        ...type!,
        is_nullable: c.notNull || c.primary ? 'NO' : 'YES',
      };
    });
    const actual = await columns('archive_node_levels');
    const byName = (a: { column_name: string }, b: { column_name: string }) =>
      a.column_name.localeCompare(b.column_name);
    expect([...actual].sort(byName)).toEqual([...expected].sort(byName));
  });

  it('node_id is the primary key, in the table and in the schema', async () => {
    const pk = (await admin`select a.attname as name
        from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
       where i.indrelid = 'public.archive_node_levels'::regclass and i.indisprimary`) as unknown as {
      name: string;
    }[];
    expect(pk.map((r) => r.name)).toEqual(['node_id']);
    const config = getTableConfig(archiveNodeLevels);
    expect(config.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['node_id']);
  });

  it('the archived columns keep the types of the nodes columns they copy', async () => {
    const nodes = new Map((await columns('nodes')).map((c) => [c.column_name, c]));
    const archive = await columns('archive_node_levels');
    const copied: Record<string, string> = { node_id: 'id' };
    for (const c of archive) {
      if (c.column_name === 'archived_at') continue;
      const src = nodes.get(copied[c.column_name] ?? c.column_name);
      expect(src, c.column_name).toBeDefined();
      expect([c.data_type, c.udt_name], c.column_name).toEqual([src!.data_type, src!.udt_name]);
    }
  });
});
