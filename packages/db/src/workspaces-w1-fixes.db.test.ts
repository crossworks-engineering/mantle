/**
 * Workspaces W1 audit fixes (migration 0245) on a real, migrated Postgres:
 * a brain item moved into a personal space needs its heads; the rule 2 race
 * (a grant against a move into a space) is serialised by the heads; the user
 * role cannot call the migration bypass; a space's kind is frozen; and the
 * boot drain skips an extraction the heads check parked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-w1-fixes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('workspaces W1 audit fixes (0245)', () => {
  let m: typeof import('./index');
  let admin: ReturnType<typeof postgres>;
  const tag = `wsw1f${randomUUID().replace(/-/g, '').slice(0, 10)}`;
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
  /** A reserved connection in an open transaction with the check 'on'. */
  const strict = async () => {
    const c = await admin.reserve();
    await c`begin`;
    await c`set local mantle.heads_check = 'on'`;
    let open = true;
    return {
      c,
      done: async (commit: boolean) => {
        if (!open) return;
        open = false;
        try {
          await (commit ? c`commit` : c`rollback`);
        } finally {
          c.release();
        }
      },
    };
  };
  const ownerOf = async (id: string) =>
    (await admin<{ o: string }[]>`select owner_id as o from nodes where id = ${id}`)[0]?.o;
  const grantsOf = async (id: string) =>
    (
      await admin<{ n: number }[]>`select count(*)::int as n from item_grants where node_id = ${id}`
    )[0]!.n;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    admin = postgres(URL!, { max: 6, prepare: false, onnotice: () => {} });
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
    await admin`delete from spaces where id = ${owner} or login_id = ${member}`;
    await admin`delete from auth.users where id in (${owner}, ${member})`;
    await admin.end();
    await m.closeDb();
  });

  it('fix 1: a brain item moved into a personal space needs its head; held, it moves', async () => {
    const item = await node(owner, 'page', 'to space', `pages.${tag}`);
    const bare = await strict();
    try {
      await expect(
        bare.c`update nodes set owner_id = ${space}, path = 'pages' where id = ${item}`,
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await bare.done(false);
    }
    expect(await ownerOf(item)).toBe(owner);
    const held = await strict();
    try {
      await held.c`select mantle_lock_heads(${`{${item}}`}::uuid[], 'update')`;
      await held.c`update nodes set owner_id = ${space}, path = 'pages' where id = ${item}`;
      await held.done(true);
    } catch (err) {
      await held.done(false);
      throw err;
    }
    expect(await ownerOf(item)).toBe(space);
    // Inside the space, a move between its own folders still needs nothing.
    const inSpace = await strict();
    try {
      await inSpace.c`update nodes set path = ${`pages.${tag}x`}::ltree where id = ${item}`;
    } finally {
      await inSpace.done(false);
    }
  });

  it('rule 2 race: a grant and a move into a space, both orders, never leave a granted space row', async () => {
    for (const grantFirst of [true, false]) {
      const item = await node(owner, 'page', `race ${grantFirst}`, `pages.${tag}`);
      const a = await strict();
      const b = await strict();
      try {
        const lockList = `{${item}}`;
        const grant = async (c: typeof a.c) => {
          await c`insert into item_grants (node_id, workspace_id) values (${item}, ${ws.team})`;
        };
        const move = async (c: typeof a.c) => {
          await c`update nodes set owner_id = ${space}, path = 'pages' where id = ${item}`;
        };
        await a.c`select mantle_lock_heads(${lockList}::uuid[], 'update')`;
        await (grantFirst ? grant(a.c) : move(a.c));
        // B waits for A's heads, then sees what A committed.
        const bLock = b.c`select mantle_lock_heads(${lockList}::uuid[], 'update')`.execute();
        await new Promise((r) => setTimeout(r, 200));
        await a.done(true);
        await bLock;
        await expect(grantFirst ? move(b.c) : grant(b.c)).rejects.toMatchObject({
          code: '23514',
        });
      } finally {
        await a.done(false);
        await b.done(false);
      }
      if (grantFirst) {
        expect(await ownerOf(item)).toBe(owner);
        expect(await grantsOf(item)).toBe(1);
      } else {
        expect(await ownerOf(item)).toBe(space);
        expect(await grantsOf(item)).toBe(0);
      }
    }
  });

  it('the user role cannot call the migration bypass', async () => {
    const r = await admin.reserve();
    try {
      await r`begin`;
      await r`set local role mantle_view_user`;
      await expect(r`select mantle_heads_bypass('x')`).rejects.toMatchObject({ code: '42501' });
    } finally {
      await r`rollback`.catch(() => {});
      r.release();
    }
  });

  it("fix 2: a space's kind is frozen", async () => {
    await expect(
      admin`update spaces set kind = 'personal' where id = ${owner}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(admin`update spaces set kind = 'brain' where id = ${space}`).rejects.toMatchObject(
      { code: '23514' },
    );
    await admin`update spaces set kind = kind where id = ${space}`;
  });

  it('the boot drain skips a parked extraction until the node changes', async () => {
    const id = await node(owner, 'note', 'parked', `notes.${tag}`);
    const since = new Date(Date.now() - 3_600_000);
    const queued = async () =>
      (
        await m.db
          .select({ id: m.nodes.id })
          .from(m.nodes)
          .where(m.and(m.unextractedNodeConds(owner, since), m.eq(m.nodes.id, id)))
      ).length;
    expect(await queued()).toBe(1);
    await m.db
      .update(m.nodes)
      .set({ data: m.sql`coalesce(${m.nodes.data}, '{}'::jsonb) || ${m.extractParkedStamp()}` })
      .where(m.eq(m.nodes.id, id));
    expect(await queued()).toBe(0);
    expect((await m.parkedExtractions(owner)).count).toBe(1);
    // A write after the park makes the stamp stale: the drain may take it again.
    await admin`update nodes set updated_at = now() + interval '1 second' where id = ${id}`;
    expect(await queued()).toBe(1);
    expect((await m.parkedExtractions(owner)).count).toBe(0);
  });
});
