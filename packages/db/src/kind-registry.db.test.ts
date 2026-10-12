/**
 * The kind registry (@mantle/client-types/kinds, workspaces arch A1) against
 * the migrated database: the `node_type` enum and the registry keys are the
 * same set (in the same order), and for every kind mantle_kind_class(t)
 * (migration 0241) equals the registry's class. A new enum value without a
 * registry entry, or a class changed on one side only, fails here.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/kind-registry.db.test.ts
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { nodeType } from './schema/nodes';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe('the kind registry and the schema', () => {
  it('the Drizzle enum and the registry keys are the same list', () => {
    expect([...nodeType.enumValues]).toEqual([...ITEM_KIND_NAMES]);
  });
});

describe.skipIf(!URL)('the kind registry on the migrated database', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(URL!, { max: 1, onnotice: () => {} });
  }, 60_000);
  afterAll(async () => {
    await sql.end();
  });

  it('enum_range(null::node_type) equals the registry keys', async () => {
    const rows = await sql<{ t: string }[]>`
      select t::text as t from unnest(enum_range(null::node_type)) as t`;
    expect(rows.map((r) => r.t)).toEqual([...ITEM_KIND_NAMES]);
  });

  it('mantle_kind_class(t) equals ITEM_KINDS[t].class for every kind', async () => {
    const rows = await sql<{ t: string; c: string }[]>`
      select t::text as t, mantle_kind_class(t) as c
      from unnest(enum_range(null::node_type)) as t`;
    const sqlClass = Object.fromEntries(rows.map((r) => [r.t, r.c]));
    const tsClass = Object.fromEntries(ITEM_KIND_NAMES.map((t) => [t, ITEM_KINDS[t].class]));
    expect(sqlClass).toEqual(tsClass);
  });
});
