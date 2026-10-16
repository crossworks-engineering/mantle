/**
 * 0297: whether others read an item, through a definer
 * (mantle_item_others_read), on a migrated scratch brain on workspaces.
 *
 *  - a workspace other than Admin holds the item, or a live link reads it:
 *    yes; only Admin, a revoked link or another owner's item: no;
 *  - in a login's scope that is not a user of the holding workspace the
 *    definer still answers yes, where a read of `workspaces` in that scope
 *    sees no holder (the workspace role reads only the scope's own
 *    workspaces): the hole the key-shared-content rule had on MCP (arch A7,
 *    access-keys-scope F1).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/item-others-read-0297.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('0297: whether others read an item, through a definer', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('./index');
  const owner = randomUUID();
  const held = randomUUID();
  const linked = randomUUID();
  const adminOnly = randomUUID();
  const ws = randomUUID();
  const tag = `ior${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const others = async (o: string, item: string) =>
    (
      await x<{ o: boolean }>(sql`select "public"."mantle_item_others_read"(${o}, ${item}) as o`)
    )[0]!.o;

  beforeAll(async () => {
    const ts: Ts = await import('./test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    await x(sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin', true)`);
    await ts.runWorkspacesSwitch(scratch.url);
    for (const [id, label] of [
      [held, 'held'],
      [linked, 'linked'],
      [adminOnly, 'adminonly'],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, 'note', ${`${tag} ${label}`}, ${`${tag}.${label}`}::ltree)`);
    }
    // A workspace the owner is not a user of holds `held`.
    await x(
      sql`insert into workspaces (id, owner_id, name) values (${ws}, ${owner}, ${`${tag} ws`})`,
    );
    await m.withHeads([held], 'update', async (tx) => {
      await tx.execute(
        sql`insert into item_grants (node_id, workspace_id) values (${held}, ${ws})`,
      );
    });
    await x(sql`insert into shares (owner_id, node_id, node_type, token)
      values (${owner}, ${linked}, 'note', ${`${tag}-live`})`);
    await x(sql`insert into shares (owner_id, node_id, node_type, token, revoked_at)
      values (${owner}, ${adminOnly}, 'note', ${`${tag}-gone`}, now())`);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('answers a holder beyond Admin or a live link; never Admin alone, a revoked link or another owner', async () => {
    expect(await others(owner, held)).toBe(true);
    expect(await others(owner, linked)).toBe(true);
    expect(await others(owner, adminOnly)).toBe(false);
    expect(await others(randomUUID(), held)).toBe(false);
    expect(await others(owner, randomUUID())).toBe(false);
  });

  it('in a scope that is not a user of the holder, the definer still sees it', async () => {
    const [row] = await m.withViewer(
      { login: owner },
      async () =>
        (await m.db.execute(
          sql`select "public"."mantle_item_others_read"(${owner}, ${held}) as definer,
                   exists (select 1 from workspaces w
                            where w.id = any (n.read_ws) and not w.is_admin) as scoped
              from nodes n where n.id = ${held}`,
        )) as unknown as { definer: boolean; scoped: boolean }[],
    );
    expect(row).toEqual({ definer: true, scoped: false });
  });
});
