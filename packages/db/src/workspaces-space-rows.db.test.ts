/**
 * Workspaces W1b (migration 0244, plan U1, V5, S6) on a real, migrated
 * Postgres: rows a personal space owns need no heads and take no grant; a
 * change of owner is a move (heads checked, folder rows derived); a folder
 * made in a heads transaction counts as held; the named migration bypass is
 * signed, logged and owner only; and the two TypeScript helpers for space
 * rows refuse to carry anything else.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-space-rows.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('workspaces W1b: personal-space rows, re-own, bypass (0244)', () => {
  let m: typeof import('./index');
  let admin: ReturnType<typeof postgres>;
  const tag = `wsw1b${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const owner = randomUUID();
  const member = randomUUID();
  const ws = { admin: randomUUID(), team: randomUUID() };
  let space = '';

  const node = async (ownerId: string, type: string, title: string, path: string) => {
    const id = randomUUID();
    await admin`insert into nodes (id, owner_id, type, title, path)
      values (${id}, ${ownerId}, ${type}::node_type, ${`${tag} ${title}`}, ${path}::ltree)`;
    return id;
  };
  const readWs = async (id: string) => {
    const [r] = await admin<{ r: string[] }[]>`select read_ws as r from nodes where id = ${id}`;
    return [...(r?.r ?? [])].sort();
  };
  /** A reserved connection in an open transaction with the check 'on'. */
  const strict = async () => {
    const c = await admin.reserve();
    await c`begin`;
    await c`set local mantle.heads_check = 'on'`;
    return {
      c,
      done: async (commit: boolean) => {
        try {
          await (commit ? c`commit` : c`rollback`);
        } finally {
          c.release();
        }
      },
    };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    admin = postgres(URL!, { max: 4, prepare: false, onnotice: () => {} });
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`;
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    space = (
      await admin<{ id: string }[]>`
        select id from spaces where kind = 'personal' and login_id = ${member}`
    )[0]!.id;
    await admin`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.admin}, ${owner}, ${`${tag} Admin`}, true),
      (${ws.team}, ${owner}, ${`${tag} Team`}, false)`;
    await admin`insert into workspace_users (workspace_id, login_id, moderator)
                values (${ws.admin}, ${owner}, true)`;
    await node(owner, 'branch', 'root', `pages.${tag}`);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from item_grants where node_id in (
      select id from nodes where owner_id in (${owner}, ${space}))`;
    await admin`delete from nodes where owner_id in (${owner}, ${space})`;
    await admin`delete from workspaces where owner_id = ${owner}`;
    await admin`delete from heads_check_misses where detail like ${`${tag}%`}`;
    await admin`delete from spaces where id = ${owner} or login_id = ${member}`;
    await admin`delete from auth.users where id in (${owner}, ${member})`;
    await admin.end();
    await m.closeDb();
  });

  it('a personal space row needs no heads; a brain row still does', async () => {
    const mine = await node(space, 'page', 'mine', 'pages');
    const brain = await node(owner, 'page', 'brain page', `pages.${tag}`);
    const t = await strict();
    try {
      await t.c`update nodes set path = ${`pages.${tag}x`}::ltree where id = ${mine}`;
      await t.c`insert into content_chunks (owner_id, node_id, ordinal, text)
                values (${space}, ${mine}, 0, 'mine')`;
      await t.c`insert into nodes (owner_id, type, title, path)
                values (${space}, 'page', ${`${tag} mine 2`}, 'pages')`;
      await t.c`delete from nodes where id = ${mine}`;
      await expect(t.c`update nodes set path = 'pages' where id = ${brain}`).rejects.toMatchObject({
        code: '40001',
      });
    } finally {
      await t.done(false);
    }
  });

  it('a personal space row takes no grant, and a granted item cannot move into a space', async () => {
    const mine = await node(space, 'page', 'no grant', 'pages');
    await expect(
      admin`insert into item_grants (node_id, workspace_id) values (${mine}, ${ws.team})`,
    ).rejects.toMatchObject({ code: '23514' });
    const granted = await node(owner, 'page', 'granted', `pages.${tag}`);
    await admin`insert into item_grants (node_id, workspace_id) values (${granted}, ${ws.team})`;
    await expect(
      admin`update nodes set owner_id = ${space}, path = 'pages' where id = ${granted}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a re-own into the brain is a move: heads checked, the folder rows derived', async () => {
    const folder = await node(owner, 'branch', 'shared', `pages.${tag}.shared`);
    await admin`insert into item_grants (node_id, workspace_id) values (${folder}, ${ws.team})`;
    const item = await node(space, 'page', 'accepted', `pages.${tag}.shared`);
    expect(await readWs(item)).toEqual([]);
    const bare = await strict();
    try {
      await expect(
        bare.c`update nodes set owner_id = ${owner} where id = ${item}`,
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await bare.done(false);
    }
    const held = await strict();
    try {
      await held.c`select mantle_lock_heads(${`{${item},${folder}}`}::uuid[], 'update')`;
      await held.c`update nodes set owner_id = ${owner} where id = ${item}`;
      await held.done(true);
    } catch (err) {
      await held.done(false);
      throw err;
    }
    expect(await readWs(item)).toEqual([ws.team]);
  });

  it('a folder made in a heads transaction counts as held for a move into it', async () => {
    const item = await node(owner, 'page', 'to new folder', `pages.${tag}`);
    const parent = (
      await admin<{ id: string }[]>`
        select id from nodes where owner_id = ${owner} and type = 'branch' and path = ${`pages.${tag}`}::ltree`
    )[0]!.id;
    const t = await strict();
    try {
      await t.c`select mantle_lock_heads(${`{${item},${parent}}`}::uuid[], 'update')`;
      await t.c`insert into nodes (owner_id, type, title, path)
                values (${owner}, 'branch', ${`${tag} fresh`}, ${`pages.${tag}.fresh`}::ltree)`;
      await t.c`update nodes set path = ${`pages.${tag}.fresh`}::ltree where id = ${item}`;
      await t.done(true);
    } catch (err) {
      await t.done(false);
      throw err;
    }
  });

  it('the migration bypass: signed, logged, owner only', async () => {
    const brain = await node(owner, 'page', 'bypass', `pages.${tag}`);
    // A hand-set bypass counts for nothing.
    const forged = await strict();
    try {
      await forged.c`select set_config('mantle.heads_bypass', ${`${tag}|nope`}, true)`;
      await expect(
        forged.c`update nodes set path = 'pages' where id = ${brain}`,
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await forged.done(false);
    }
    // The named call turns the check off for this transaction, and logs it.
    const named = await strict();
    try {
      await named.c`select mantle_heads_bypass(${`${tag} test migration`})`;
      await named.c`update nodes set path = 'pages' where id = ${brain}`;
      await named.done(true);
    } catch (err) {
      await named.done(false);
      throw err;
    }
    const [log] = await admin<{ n: number }[]>`
      select count(*)::int as n from heads_check_misses
       where check_name = 'bypass' and detail = ${`${tag} test migration`}`;
    expect(log!.n).toBe(1);
    // A limited role cannot call it.
    const role = await admin.reserve();
    try {
      await role`begin`;
      await role`set local role mantle_view_space`;
      await expect(role`select mantle_heads_bypass('x')`).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await role`rollback`.catch(() => {});
      role.release();
    }
  });

  it('withSpaceRows runs only in a space scope; onSpaceRows only on personal spaces', async () => {
    await expect(m.withSpaceRows(async () => 1)).rejects.toThrow(/personal-space scope/);
    await expect(
      m.withSpace({ spaceId: space, loginId: member }, () => m.withSpaceRows(async () => 2)),
    ).resolves.toBe(2);
    await expect(m.onSpaceRows(m.systemDb, [space, owner], async () => 3)).rejects.toThrow(
      /personal space/,
    );
    await expect(m.onSpaceRows(m.systemDb, space, async () => 4)).resolves.toBe(4);
  });
});
