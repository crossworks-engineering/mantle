/**
 * Workspaces W1 (plan page 4887b8e7, migrations 0241 and 0242): the model in
 * shadow, tested on a real, migrated Postgres. Covers the W0/W1 tests of
 * sections 19.6 and 21.6 that W1 can run: grants and their derived columns,
 * folder derivation (nearest folder wins, exclusions survive, a deep rename
 * runs once), one home per item, the kind rule, the heads locks (first lock,
 * NOWAIT rounds, the move and folder-change races in both orders, the
 * three-party race with an ingest), the heads check in 'warn' and 'on', the
 * delete path, the workspace role's read rule (and per-login rows), and the
 * placement rule for a user scope.
 *
 * Seeds its own brain-kind owner so it never touches the shared anchor's
 * items, and removes everything it made.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Sql = ReturnType<typeof postgres>;

describe.skipIf(!URL)('workspaces W1: grants, derivation, heads and the workspace role', () => {
  type Db = typeof import('./index');
  let m: Db;
  let admin: Sql;
  const tag = `wsw1${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const owner = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const ws = { admin: randomUUID(), team: randomUUID(), other: randomUUID() };
  const root = `pages.${tag}`;

  /** A node row on the admin connection, outside any heads (the tests that
   *  care take heads themselves). */
  const node = async (
    type: string,
    title: string,
    path: string,
    extra: { id?: string; loginId?: string } = {},
  ): Promise<string> => {
    const id = extra.id ?? randomUUID();
    await admin`insert into nodes (id, owner_id, type, title, path, login_id)
      values (${id}, ${owner}, ${type}::node_type, ${`${tag} ${title}`}, ${path}::ltree,
              ${extra.loginId ?? null})`;
    return id;
  };
  const readWs = async (id: string): Promise<string[]> => {
    const [r] = await admin<{ r: string[] }[]>`select read_ws as r from nodes where id = ${id}`;
    return [...(r?.r ?? [])].sort();
  };
  const writeWs = async (id: string): Promise<string[]> => {
    const [r] = await admin<{ w: string[] }[]>`select write_ws as w from nodes where id = ${id}`;
    return [...(r?.w ?? [])].sort();
  };
  const grant = (nodeId: string, wsId: string, write = false) =>
    admin`insert into item_grants (node_id, workspace_id, write) values (${nodeId}, ${wsId}, ${write})
          on conflict (node_id, workspace_id) do update set write = excluded.write, via_folder_id = null`;
  const sorted = (...ids: string[]) => [...ids].sort();

  /** A reserved connection with an open transaction. */
  const txConn = async () => {
    const c = await admin.reserve();
    await c`begin`;
    let open = true;
    return {
      c,
      commit: async () => {
        if (!open) return;
        open = false;
        try {
          await c`commit`;
        } finally {
          c.release();
        }
      },
      rollback: async () => {
        if (!open) return;
        open = false;
        await c`rollback`.catch(() => {});
        c.release();
      },
    };
  };
  /** Resolves once `pid` waits on a lock. */
  const waitingOnLock = async (pid: number) => {
    for (let i = 0; i < 200; i++) {
      const [r] = await admin<{ w: boolean }[]>`
        select wait_event_type = 'Lock' as w from pg_stat_activity where pid = ${pid}`;
      if (r?.w) return;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`pid ${pid} never waited on a lock`);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    admin = postgres(URL!, { max: 6, prepare: false, onnotice: () => {} });
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await admin`insert into auth.users (id, email, password_hash, role) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin'),
      (${userA}, ${`${tag}-a@example.invalid`}, 'x', 'member'),
      (${userB}, ${`${tag}-b@example.invalid`}, 'x', 'member')`;
    // This file's own brain-kind owner: one Admin workspace per owner, and
    // no other test file's items in its trees.
    await admin`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await admin`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.admin}, ${owner}, ${`${tag} Admin`}, true),
      (${ws.team}, ${owner}, ${`${tag} Team`}, false),
      (${ws.other}, ${owner}, ${`${tag} Other`}, false)`;
    await admin`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.admin}, ${owner}, true), (${ws.team}, ${userA}, true), (${ws.team}, ${userB}, false)`;
    await node('branch', 'root', root);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from item_grants where node_id in (select id from nodes where owner_id = ${owner})`;
    await admin`delete from nodes where owner_id = ${owner}`;
    await admin`delete from workspace_users where workspace_id in ${admin([ws.admin, ws.team, ws.other])}`.catch(
      () => {},
    );
    await admin`delete from workspaces where owner_id = ${owner}`;
    await admin`delete from spaces where id = ${owner} or login_id in ${admin([owner, userA, userB])}`;
    await admin`delete from auth.users where id in ${admin([owner, userA, userB])}`;
    await admin.end();
    await m.closeDb();
  });

  it('every node gets a head row, at insert and by the migration backfill', async () => {
    const id = await node('page', 'head', root);
    const [r] = await admin<
      { n: number }[]
    >`select count(*)::int as n from node_acl_head where node_id = ${id}`;
    expect(r!.n).toBe(1);
    const [missing] = await admin<{ n: number }[]>`
      select count(*)::int as n from nodes n
       where not exists (select 1 from node_acl_head h where h.node_id = n.id)`;
    expect(missing!.n).toBe(0);
  });

  it('a grant sets read_ws and write_ws in the same statement; removing it clears them', async () => {
    const id = await node('page', 'direct', root);
    await grant(id, ws.team, true);
    expect(await readWs(id)).toEqual([ws.team]);
    expect(await writeWs(id)).toEqual([ws.team]);
    await admin`update item_grants set write = false where node_id = ${id}`;
    expect(await writeWs(id)).toEqual([]);
    await admin`delete from item_grants where node_id = ${id}`;
    expect(await readWs(id)).toEqual([]);
  });

  it('test 4: exactly one home row per node, and home_ws follows it', async () => {
    const id = await node('note', 'home', root);
    await admin`insert into item_grants (node_id, workspace_id, is_home) values (${id}, ${ws.team}, true)`;
    const [r] = await admin<{ h: string }[]>`select home_ws as h from nodes where id = ${id}`;
    expect(r!.h).toBe(ws.team);
    await expect(
      admin`insert into item_grants (node_id, workspace_id, is_home) values (${id}, ${ws.other}, true)`,
    ).rejects.toThrow(/item_grants_one_home_uq/);
    await expect(
      admin`update item_grants set excluded = true where node_id = ${id} and workspace_id = ${ws.team}`,
    ).rejects.toThrow(/item_grants_home_not_excluded_ck/);
  });

  it('the kind rule: an Admin-only kind is granted to the Admin workspace only', async () => {
    const email = await node('email', 'mail', root);
    await expect(grant(email, ws.team)).rejects.toThrow(/Admin workspace only/);
    await grant(email, ws.admin);
    expect(await readWs(email)).toEqual([ws.admin]);
  });

  it('test 2: a new item in a granted folder gets the folder rows (grant rows after the insert)', async () => {
    const f = await node('branch', 'f2', `${root}.f2`);
    await grant(f, ws.team, true);
    await grant(f, ws.admin);
    const p = await node('page', 'in f2', `${root}.f2`);
    const e = await node('email', 'mail in f2', `${root}.f2`);
    expect(await readWs(p)).toEqual(sorted(ws.team, ws.admin));
    expect(await writeWs(p)).toEqual([ws.team]);
    // The Admin-only kind takes only the Admin row.
    expect(await readWs(e)).toEqual([ws.admin]);
    const rows = await admin<{ via: string }[]>`
      select via_folder_id as via from item_grants where node_id = ${p}`;
    expect(rows.every((r) => r.via === f)).toBe(true);
  });

  it('tests 3 and 5: nested folders, nearest wins, exclusions survive, a deep rename keeps every row', async () => {
    // Folders nest four levels at most (nodes_tree_folder_depth_ck).
    const a = await node('branch', 'a', `${root}.a`);
    const b = await node('branch', 'b', `${root}.a.b`);
    const deep = await node('page', 'deep', `${root}.a.b`);
    const kept = await node('page', 'excluded', `${root}.a.b`);
    await grant(a, ws.team, false);
    // B grants Team itself, with Write on: the nearest folder wins below B.
    await grant(b, ws.team, true);
    expect(await writeWs(deep)).toEqual([ws.team]);
    // "Removed here": an exclusion row on one item.
    await admin`update item_grants set excluded = true, via_folder_id = null
                 where node_id = ${kept} and workspace_id = ${ws.team}`;
    expect(await readWs(kept)).toEqual([]);
    // Removing B's own row: below B the grant now comes from A (Write off).
    await admin`delete from item_grants where node_id = ${b} and workspace_id = ${ws.team}`;
    expect(await readWs(deep)).toEqual([ws.team]);
    expect(await writeWs(deep)).toEqual([]);
    // The depth guard never skips upkeep: B (a derived folder) follows too.
    expect(await readWs(b)).toEqual([ws.team]);
    // A deep rename rewrites every path in one statement; nothing changes.
    await admin`update nodes
                   set path = case when path = ${`${root}.a`}::ltree then ${`${root}.a2`}::ltree
                              else ${`${root}.a2`}::ltree || subpath(path, nlevel(${`${root}.a`}::ltree)) end
                 where owner_id = ${owner} and path <@ ${`${root}.a`}::ltree`;
    expect(await readWs(deep)).toEqual([ws.team]);
    expect(await readWs(kept)).toEqual([]);
    const [ex] = await admin<{ e: boolean }[]>`
      select excluded as e from item_grants where node_id = ${kept} and workspace_id = ${ws.team}`;
    expect(ex!.e).toBe(true);
    // "Restore": dropping the exclusion brings the folder's row back.
    await admin`delete from item_grants where node_id = ${kept} and workspace_id = ${ws.team}`;
    expect(await readWs(kept)).toEqual([ws.team]);
  });

  it('a move re-derives: out of a granted folder the derived rows go, hand rows stay', async () => {
    const f = await node('branch', 'mv', `${root}.mv`);
    await grant(f, ws.team);
    const p = await node('page', 'moving', `${root}.mv`);
    await grant(p, ws.other); // a hand row
    expect(await readWs(p)).toEqual(sorted(ws.team, ws.other));
    await admin`update nodes set path = ${root}::ltree where id = ${p}`;
    expect(await readWs(p)).toEqual([ws.other]);
  });

  it('test 14: heads must be the first lock; a second mantle_lock_heads is refused', async () => {
    const id = await node('page', 'first', root);
    const t = await txConn();
    try {
      await t.c`set local mantle.heads_check = 'on'`;
      await t.c`update nodes set title = title where id = ${id}`;
      await expect(t.c`select mantle_lock_heads(${`{${id}}`}::uuid[], 'update')`).rejects.toThrow(
        /first lock/,
      );
    } finally {
      await t.rollback();
    }
    const t2 = await txConn();
    try {
      await t2.c`select mantle_lock_heads(${`{${id}}`}::uuid[], 'update')`;
      await expect(t2.c`select mantle_lock_heads(${`{${id}}`}::uuid[], 'update')`).rejects.toThrow(
        /already held/,
      );
    } finally {
      await t2.rollback();
    }
  });

  it('test 17: a chunk written without its head: warn counts it, on fails with 40001', async () => {
    const id = await node('page', 'chunk', root);
    const before = await admin<{ n: number }[]>`
      select count(*)::int as n from heads_check_misses where check_name = 'content_chunks_write' and node_id = ${id}`;
    await admin`insert into content_chunks (owner_id, node_id, ordinal, text) values (${owner}, ${id}, 0, 'x')`;
    const after = await admin<{ n: number }[]>`
      select count(*)::int as n from heads_check_misses where check_name = 'content_chunks_write' and node_id = ${id}`;
    expect(after[0]!.n).toBe(before[0]!.n + 1);

    const t = await txConn();
    try {
      await t.c`set local mantle.heads_check = 'on'`;
      await expect(
        t.c`insert into content_chunks (owner_id, node_id, ordinal, text) values (${owner}, ${id}, 1, 'y')`,
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await t.rollback();
    }
    // With its head first, in 'on' mode, the chunk copies the node's rows.
    await grant(id, ws.team);
    const t2 = await txConn();
    try {
      await t2.c`set local mantle.heads_check = 'on'`;
      await t2.c`select mantle_lock_heads(${`{${id}}`}::uuid[], 'update')`;
      await t2.c`insert into content_chunks (owner_id, node_id, ordinal, text) values (${owner}, ${id}, 2, 'z')`;
      await t2.commit();
    } catch (err) {
      await t2.rollback();
      throw err;
    }
    const [c] = await admin<{ r: string[] }[]>`
      select read_ws as r from content_chunks where node_id = ${id} and ordinal = 2`;
    expect(c!.r).toEqual([ws.team]);
  });

  it('test 16: deleting a node with facts and chunks never trips the check; facts keep read_ws', async () => {
    const id = await node('page', 'doomed', root);
    await grant(id, ws.team);
    await admin`insert into content_chunks (owner_id, node_id, ordinal, text) values (${owner}, ${id}, 0, 'x')`;
    const [f] = await admin<{ id: string }[]>`
      insert into facts (owner_id, content, kind, source_node_id) values (${owner}, ${`${tag} fact`}, 'semantic', ${id})
      returning id`;
    const t = await txConn();
    try {
      await t.c`set local mantle.heads_check = 'on'`;
      await t.c`delete from nodes where id = ${id}`;
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
    const [fact] = await admin<{ s: string | null; r: string[] }[]>`
      select source_node_id as s, read_ws as r from facts where id = ${f!.id}`;
    expect(fact!.s).toBeNull();
    expect(fact!.r).toEqual([ws.team]);
    await admin`delete from facts where id = ${f!.id}`;
  });

  it('test 13: a later round never waits: a busy head fails with 55P03', async () => {
    const x = await node('page', 'busy', root);
    const y = await node('page', 'holder', root);
    const holder = await txConn();
    const other = await txConn();
    try {
      await holder.c`select mantle_lock_heads(${`{${x}}`}::uuid[], 'update')`;
      await other.c`select mantle_lock_heads(${`{${y}}`}::uuid[], 'update')`;
      await expect(
        other.c`select mantle_lock_heads_more(${`{${x}}`}::uuid[])`,
      ).rejects.toMatchObject({
        code: '55P03',
      });
    } finally {
      await other.rollback();
      await holder.rollback();
    }
  });

  it('test 1: a move into a folder races that folder losing a grant, both orders', async () => {
    for (const order of ['change-first', 'move-first'] as const) {
      const f2 = await node('branch', `race-${order}`, `${root}.race${order.replace('-', '')}`);
      await grant(f2, ws.team);
      await grant(f2, ws.other);
      const x = await node('page', `racer-${order}`, root);
      const p1 = (
        await admin<{ id: string }[]>`
        select id from nodes where owner_id = ${owner} and type = 'branch' and path = ${root}::ltree`
      )[0]!.id;

      const change = async (t: Awaited<ReturnType<typeof txConn>>) => {
        await t.c`select mantle_lock_subtree_heads(${f2}::uuid, '{}'::uuid[])`;
        await t.c`delete from item_grants where node_id = ${f2} and workspace_id = ${ws.other}`;
      };
      const move = async (t: Awaited<ReturnType<typeof txConn>>) => {
        await t.c`select mantle_lock_subtree_heads(${x}::uuid, ${`{${p1},${f2}}`}::uuid[])`;
        await t.c`update nodes set path = (select path from nodes where id = ${f2}) where id = ${x}`;
      };

      const first = await txConn();
      const second = await txConn();
      try {
        await (order === 'change-first' ? change(first) : move(first));
        const pid = (await second.c<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
        const pending = order === 'change-first' ? move(second) : change(second);
        await waitingOnLock(pid);
        await first.commit();
        await pending;
        await second.commit();
      } catch (err) {
        await first.rollback();
        await second.rollback();
        throw err;
      }
      // Either way X ends inside F2 with F2's rows after the change: Team only.
      expect(await readWs(x)).toEqual([ws.team]);
    }
  });

  it('three parties: a folder change, a move into a sub-folder and an ingest of the moved item', async () => {
    const f = await node('branch', 'three', `${root}.three`);
    const g = await node('branch', 'three-sub', `${root}.three.sub`);
    await grant(f, ws.team);
    await grant(f, ws.other);
    const x = await node('page', 'three-x', root);
    const p1 = (
      await admin<{ id: string }[]>`
      select id from nodes where owner_id = ${owner} and type = 'branch' and path = ${root}::ltree`
    )[0]!.id;

    const mover = await txConn();
    const changer = await txConn();
    const ingest = await txConn();
    try {
      // The move holds its heads first and moves X under F (into G).
      await mover.c`select mantle_lock_subtree_heads(${x}::uuid, ${`{${p1},${g}}`}::uuid[])`;
      await mover.c`update nodes set path = ${`${root}.three.sub`}::ltree where id = ${x}`;
      // The folder change on F waits for G's head (held by the move).
      const cpid = (await changer.c<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      // A later round that meets a busy head fails with 55P03 and the
      // caller retries the whole transaction (V1).
      let changeTx = changer;
      const changing = (async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            await changeTx.c`select mantle_lock_subtree_heads(${f}::uuid, '{}'::uuid[])`;
            await changeTx.c`delete from item_grants where node_id = ${f} and workspace_id = ${ws.other}`;
            await changeTx.commit();
            return attempt;
          } catch (err) {
            await changeTx.rollback();
            if ((err as { code?: string }).code !== '55P03' || attempt >= 5) throw err;
            await new Promise((r) => setTimeout(r, 50));
            changeTx = await txConn();
          }
        }
      })();
      await waitingOnLock(cpid);
      // The ingest of X waits for X's head too.
      const ipid = (await ingest.c<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      const ingesting = (async () => {
        await ingest.c`select mantle_lock_heads(${`{${x}}`}::uuid[], 'update')`;
        await ingest.c`delete from content_chunks where node_id = ${x}`;
        await ingest.c`insert into content_chunks (owner_id, node_id, ordinal, text) values (${owner}, ${x}, 0, 'x')`;
      })();
      await waitingOnLock(ipid);
      await mover.commit();
      await ingesting;
      await ingest.commit();
      await changing;
    } catch (err) {
      await mover.rollback();
      await ingest.rollback();
      throw err;
    }
    expect(await readWs(x)).toEqual([ws.team]);
    const chunks = await admin<
      { r: string[] }[]
    >`select read_ws as r from content_chunks where node_id = ${x}`;
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.r).toEqual([ws.team]);
  });

  it('the workspace role reads only what the scope holds, per-login rows only by their login', async () => {
    const shared = await node('page', 'shared', root);
    const hidden = await node('page', 'hidden', root);
    const mineA = await node('telegram_message', 'chat of A', root, { loginId: userA });
    await grant(shared, ws.team);
    await grant(hidden, ws.other);
    await grant(mineA, ws.team);
    const { sql: sqlTag } = await import('drizzle-orm');
    const titles = async (loginId: string) =>
      m.withScope({ kind: 'user', loginId, ws: [ws.team], modWs: [] }, async () =>
        (
          (await m.db.execute(
            sqlTag`select title from nodes where title like ${`${tag}%`} order by title`,
          )) as unknown as { title: string }[]
        ).map((r) => r.title),
      );
    const seenByA = await titles(userA);
    const seenByB = await titles(userB);
    expect(seenByA).toContain(`${tag} shared`);
    expect(seenByA).toContain(`${tag} chat of A`);
    expect(seenByA).not.toContain(`${tag} hidden`);
    expect(seenByB).toContain(`${tag} shared`);
    expect(seenByB).not.toContain(`${tag} chat of A`);
  });

  it('test 10: currentScope reports the scope; currentViewerLevel refuses inside a workspace scope', async () => {
    expect(m.currentScope()).toEqual({ kind: 'system' });
    await m.withViewer('team', async () => {
      expect(m.currentScope()).toEqual({ kind: 'level', level: 'team' });
    });
    await m.withScope({ kind: 'assistant', loginId: null, ws: [ws.team], modWs: [] }, async () => {
      expect(m.currentScope().kind).toBe('assistant');
      expect(() => m.currentViewerLevel()).toThrow(m.ScopeLevelError);
    });
  });

  it('test 6: a user scope may place an item only where it may edit, and move only what it manages', async () => {
    const dest = await node('branch', 'dest', `${root}.dest`);
    await admin`insert into item_grants (node_id, workspace_id, is_home) values (${dest}, ${ws.team}, true)`;
    const item = await node('page', 'placed', root);
    await admin`insert into item_grants (node_id, workspace_id, is_home) values (${item}, ${ws.other}, true)`;
    const tryMove = async (mod: string[]) => {
      const t = await txConn();
      try {
        await t.c`select set_config('mantle.ws', ${`{${[ws.team, ws.other].join(',')}}`}, true),
                         set_config('mantle.mod_ws', ${`{${mod.join(',')}}`}, true)`;
        await t.c`update nodes set path = ${`${root}.dest`}::ltree where id = ${item}`;
        await t.rollback();
      } catch (err) {
        await t.rollback();
        throw err;
      }
    };
    // Moderates neither: may not move the item.
    await expect(tryMove([])).rejects.toMatchObject({ code: '42501' });
    // Manages the item but may not add to the Team folder.
    await expect(tryMove([ws.other])).rejects.toMatchObject({ code: '42501' });
    // Both: allowed (placing is accepting).
    await expect(tryMove([ws.other, ws.team])).resolves.toBeUndefined();
  });

  it('the app exception: placing an app that adds a holder needs Moderator of that workspace', async () => {
    const dest = await node('branch', 'appdest', `${root}.appdest`);
    await admin`insert into item_grants (node_id, workspace_id, is_home, write) values (${dest}, ${ws.team}, true, true)`;
    await grant(dest, ws.other);
    const app = await node('app', 'an app', root);
    await admin`insert into item_grants (node_id, workspace_id, is_home) values (${app}, ${ws.team}, true)`;
    const t = await txConn();
    try {
      // Moderator of Team only: the folder adds Other, which they do not moderate.
      await t.c`select set_config('mantle.ws', ${`{${[ws.team, ws.other].join(',')}}`}, true),
                       set_config('mantle.mod_ws', ${`{${ws.team}}`}, true)`;
      await expect(
        t.c`update nodes set path = ${`${root}.appdest`}::ltree where id = ${app}`,
      ).rejects.toThrow(/do not moderate/);
    } finally {
      await t.rollback();
    }
  });

  it('an assistant keeps its workspace once it has history', async () => {
    const agent = randomUUID();
    await admin`insert into agents (id, owner_id, slug, name, system_prompt, model)
      values (${agent}, ${owner}, ${`${tag}-bot`}, 'bot', '', 'x/y')`;
    await admin`insert into workspace_resources (workspace_id, type, ref_id) values (${ws.team}, 'assistant', ${agent})`;
    const [a] = await admin<
      { w: string }[]
    >`select workspace_id as w from agents where id = ${agent}`;
    expect(a!.w).toBe(ws.team);
    await admin`insert into assistant_messages (owner_id, agent_id, direction, text)
      values (${owner}, ${agent}, 'inbound', 'hi')`;
    await admin`delete from workspace_resources where ref_id = ${agent}`;
    await expect(
      admin`insert into workspace_resources (workspace_id, type, ref_id) values (${ws.other}, 'assistant', ${agent})`,
    ).rejects.toThrow(/clone it/);
    await admin`delete from assistant_messages where agent_id = ${agent}`;
    await admin`update agents set workspace_id = null where id = ${agent}`;
    await admin`delete from agents where id = ${agent}`;
  });

  it('withDeadlockRetry retries the whole run for retryable codes only', async () => {
    let runs = 0;
    await expect(
      m.withDeadlockRetry(async () => {
        runs++;
        if (runs < 3) throw Object.assign(new Error('deadlock'), { code: '40P01' });
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(runs).toBe(3);
    runs = 0;
    await expect(
      m.withDeadlockRetry(async () => {
        runs++;
        throw Object.assign(new Error('nope'), { code: '23505' });
      }),
    ).rejects.toThrow('nope');
    expect(runs).toBe(1);
  });
});
