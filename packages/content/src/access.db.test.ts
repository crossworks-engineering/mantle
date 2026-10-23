/**
 * The frozen agent and tool-group levels (migration 0268, workspaces W7b;
 * the per-login MCP switch table went in 0273) against a real, migrated
 * Postgres, and the plain unshare of workspaces W5b2: revoking a link changes no level and no
 * grant. Seeds its own owner and rows and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/access.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('frozen levels and the plain unshare, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  type Access = typeof import('./access');
  let m: Db;
  let a: Access;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const ids = { note: randomUUID(), agent: randomUUID() };
  const tag = `access-test-${owner.slice(0, 8)}`;

  const accessOf = async (id: string) =>
    (
      (await m.db.execute(
        sqlTag`select audience, read_ws::text as read_ws from nodes where id = ${id}`,
      )) as unknown as { audience: string; read_ws: string }[]
    )[0]!;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    a = await import('./access');
    sqlTag = (await import('drizzle-orm')).sql;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    // Items belong to a space (0165): this test's own owner is a brain row.
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path) values
        (${ids.note}, ${owner}, 'note', 'n', 'notes')`);
    await m.db.execute(sqlTag`
      insert into tool_groups (owner_id, slug, name, audience) values
        (${owner}, ${`${tag}-admin`}, 'admin group', 'admin'),
        (${owner}, ${`${tag}-team`}, 'team group', 'team')`);
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${ids.agent}, ${owner}, ${`${tag}-agent`}, 'A', 'm', 'p',
              ${`{${tag}-admin,${tag}-team}`}::text[])`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from agents where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from tool_groups where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('unshare is a plain revoke: no level, no grant changes', async () => {
    const shareId = randomUUID();
    await m.db.execute(sqlTag`
      insert into shares (id, owner_id, node_id, node_type, token)
      values (${shareId}, ${owner}, ${ids.note}, 'note', ${`${tag}-tok`})`);
    const before = await accessOf(ids.note);
    await expect(a.unshareItem(owner, shareId)).resolves.toEqual({ revoked: true });
    const [row] = (await m.db.execute(
      sqlTag`select revoked_at is not null as revoked from shares where id = ${shareId}`,
    )) as unknown as { revoked: boolean }[];
    expect(row?.revoked).toBe(true);
    expect(await accessOf(ids.note)).toEqual(before);
    // Already gone, or another owner's: nothing to revoke.
    await expect(a.unshareItem(owner, shareId)).resolves.toEqual({ revoked: false });
    await expect(a.unshareItem(randomUUID(), shareId)).resolves.toEqual({ revoked: false });
  });

  it('agent and tool-group levels are frozen (0268, W7b): a change keeps the old value', async () => {
    const level = async (q: ReturnType<typeof sqlTag>) =>
      ((await m.db.execute(q)) as unknown as { audience: string }[])[0]?.audience;
    await m.db.execute(
      sqlTag`update agents set audience = 'team', name = 'B' where id = ${ids.agent}`,
    );
    expect(await level(sqlTag`select audience, name from agents where id = ${ids.agent}`)).toBe(
      'admin',
    );
    await m.db.execute(
      sqlTag`update tool_groups set audience = 'admin' where owner_id = ${owner} and slug = ${`${tag}-team`}`,
    );
    expect(
      await level(
        sqlTag`select audience from tool_groups where owner_id = ${owner} and slug = ${`${tag}-team`}`,
      ),
    ).toBe('team');
    // The other columns of the row still change.
    const [named] = (await m.db.execute(
      sqlTag`select name from agents where id = ${ids.agent}`,
    )) as unknown as { name: string }[];
    expect(named?.name).toBe('B');
    // The archive tables are the system's alone.
    const [n] = (await m.db.execute(
      sqlTag`select count(*)::int as n from archive_tool_levels where owner_id = ${owner}`,
    )) as unknown as { n: number }[];
    expect(n?.n).toBe(0);
  });
});
