/**
 * Workspaces W4a (migration 0250): the workspaces go live as data, on a
 * scratch database of its own, with the bridge off since W5b2 (0261). A small
 * brain with an owner, a member, items at each level (written by the insert,
 * as a brain made before the switch holds them), a shared folder, apps,
 * personal items, assistants, connectors and facts. Checked:
 *
 *  - a brain with a client login is skipped (nothing written), then migrated
 *    once the client is gone; a second run does nothing;
 *  - the 9.2 table, as plain grants: every brain item has one home, Team
 *    where the team read it, derived from the folder where the folder's
 *    share gave it; no "removed here" without a folder grant; personal items
 *    homed in their author's private workspace (0267); the reach diff finds
 *    no gain, a second run neither; resources and the R3 stamp;
 *  - no bridge: a level change is refused, a new item takes a home and its
 *    folder's rows, an app's read-only switch writes no grant, a moved item
 *    keeps its home;
 *  - a login joins the workspaces only by name (mantle_bridge_login);
 *  - facts with a source follow their node (a grant change writes no fact),
 *    a deleted source freezes the fact's access, a cleared one too;
 *  - chat facts map to Admin.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-live.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';
import { GRANT_DRIFT_SQL } from './workspaces-check';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = { section: string; subject: string; metric: string; n: string };
type Grant = { ws: string; home: boolean; excluded: boolean; write: boolean; bridge: boolean };

describe.skipIf(!URL)('workspaces live (0250): migration, bridges, facts', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const ids: Record<string, string> = {};
  let spaceA = '';
  let admin = '';
  let team = '';

  /** A node; `share` and `inherited` are the folder levels a brain made
   *  before the switch holds (the insert names them: no upkeep trigger). */
  const node = async (
    key: string,
    owner_: string,
    type: string,
    path: string,
    audience = 'admin',
    levels: { share?: string; inherited?: string } = {},
  ) => {
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience, share_level, inherited_level)
      values (${id}, ${owner_}, ${type}::node_type, ${key}, ${path}::ltree, ${audience},
              ${levels.share ?? null}, ${levels.inherited ?? null})`;
    ids[key] = id;
    return id;
  };
  const drift = async () => Number((await sql.unsafe(GRANT_DRIFT_SQL))[0]!.n);
  const bridgeRows = async () =>
    Number((await sql`select count(*) as n from item_grants where bridge`)[0]!.n);
  const grants = async (id: string): Promise<Record<string, Grant>> => {
    const rows = await sql<(Grant & { name: string })[]>`
      select w.name, g.workspace_id::text as ws, g.is_home as home, g.excluded, g.write, g.bridge
        from item_grants g join workspaces w on w.id = g.workspace_id
       where g.node_id = ${id}`;
    return Object.fromEntries(rows.map(({ name, ...g }) => [name, g]));
  };
  const readWs = async (id: string) =>
    (await sql<{ r: string[] }[]>`select read_ws::text[] as r from nodes where id = ${id}`)[0]!.r;
  /** Reads under the workspace role with a scope, as withScope sets it. */
  const asUser = <T>(
    ws: string[],
    login: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ) =>
    sql.begin(async (tx) => {
      await tx`select set_config('mantle.ws', ${`{${ws.join(',')}}`}, true),
                      set_config('mantle.login_id', ${login ?? ''}, true)`;
      await tx`set local role mantle_view_user`;
      return fn(tx);
    }) as Promise<T>;
  const numbered = (rows: Row[]) => rows.map((r) => ({ ...r, n: Number(r.n) }));
  const migrate = async () => numbered(await sql<Row[]>`select * from mantle_ws_migrate()`);

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o@example.invalid', 'x', 'admin', true),
      (${member}, 'm@example.invalid', 'x', 'member', false)`;
    spaceA = (
      await sql<
        { id: string }[]
      >`select id from spaces where kind = 'personal' and login_id = ${member}`
    )[0]!.id;

    await node('adminPage', owner, 'page', 'pages', 'admin');
    await node('teamPage', owner, 'page', 'pages', 'team');
    await node('publicNote', owner, 'note', 'notes', 'public');
    await node('email', owner, 'email', 'emails', 'admin');
    // A folder the team reads and shares: its Team row passes on (a folder
    // shared by its share level alone holds none, see the bridge-off test).
    await node('folder', owner, 'branch', 'pages.shared', 'team', { share: 'team' });
    await node('inFolder', owner, 'page', 'pages.shared', 'admin', { inherited: 'team' });
    await node('teamApp', owner, 'app', 'apps', 'team');
    await node('roApp', owner, 'app', 'apps', 'team');
    await node('adminApp', owner, 'app', 'apps', 'admin');
    await sql`insert into apps (node_id, source, data_read_only) values
      (${ids.teamApp!}, '{}'::jsonb, false), (${ids.roApp!}, '{}'::jsonb, true),
      (${ids.adminApp!}, '{}'::jsonb, false)`;
    await node('draft', spaceA, 'page', 'pages', 'admin');

    // Assistants and connectors.
    const agent = async (slug: string, role: string, audience: string) => {
      const id = randomUUID();
      await sql`insert into agents (id, owner_id, slug, name, role, audience, model, system_prompt)
        values (${id}, ${owner}, ${slug}, ${slug}, ${role}::agent_role, ${audience}, 'm', 'p')`;
      ids[slug] = id;
    };
    await agent('persona', 'responder', 'admin');
    await agent('team-responder', 'custom', 'team');
    await sql`insert into tool_groups (owner_id, slug, name, integration, audience) values
      (${owner}, 'conn-admin', 'a', '{"mcp":{}}'::jsonb, 'admin'),
      (${owner}, 'conn-team', 't', '{"mcp":{}}'::jsonb, 'team'),
      (${owner}, 'plain', 'p', null, 'team')`;
    await sql`insert into tool_groups (owner_id, slug, name, integration, audience, enabled) values
      (${owner}, 'conn-off', 'o', '{"mcp":{}}'::jsonb, 'team', false)`;

    // A chat fact and a fact from the team page.
    await sql`insert into facts (owner_id, content, kind) values (${owner}, 'chat fact', 'semantic')`;
    await sql`insert into facts (owner_id, content, kind, source_node_id)
      values (${owner}, 'page fact', 'factual', ${ids.teamPage!})`;
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('skips a brain with a client login and writes nothing; migrates once it is gone; runs once', async () => {
    // Since 0272 the role CHECK admits admin and member only; a brain from
    // before it could hold a client login. The CHECK is lifted for this one
    // transaction, which is rolled back: the client is gone after it.
    const rollback = new Error('rollback');
    let skipped: Awaited<ReturnType<typeof migrate>> = [];
    let written = { workspaces: -1, grants: -1 };
    await sql
      .begin(async (tx) => {
        await tx`alter table auth.users drop constraint users_role_ck`;
        await tx`insert into auth.users (id, email, password_hash, role) values
          (${randomUUID()}, 'c@example.invalid', 'x', 'client')`;
        skipped = numbered(await tx<Row[]>`select * from mantle_ws_migrate()`);
        written = {
          workspaces: Number((await tx`select count(*) as n from workspaces`)[0]!.n),
          grants: Number((await tx`select count(*) as n from item_grants`)[0]!.n),
        };
        throw rollback;
      })
      .catch((err: unknown) => {
        if (err !== rollback) throw err;
      });
    expect(skipped.filter((r) => r.section === 'skip').map((r) => [r.subject, r.n])).toEqual([
      ['client logins', 1],
      ['client-level items', 0],
    ]);
    expect(written).toEqual({ workspaces: 0, grants: 0 });

    const done = await migrate();
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    expect(done.find((r) => r.subject === 'workspaces')?.n).toBe(2);
    // Team holds the team items and the member: kept, a normal workspace
    // (0286: no bridge_key, no admin_moderated).
    const ws = await sql<
      { id: string; bridge_key: string | null; name: string; admin_moderated: boolean }[]
    >`select id, bridge_key, name, admin_moderated from workspaces`;
    admin = ws.find((w) => w.bridge_key === 'admin')!.id;
    const t = ws.find((w) => w.name === 'Team')!;
    expect(t).toMatchObject({ bridge_key: null, admin_moderated: false });
    team = t.id;
    expect((await migrate())[0]).toMatchObject({ section: 'skip', metric: 'already migrated' });
  });

  it('writes the 9.2 table as plain grants: one home per brain item, Team where the team read, nothing personal', async () => {
    expect(await bridgeRows()).toBe(0);
    // No "removed here" without a folder grant to remove.
    expect(await grants(ids.adminPage!)).toEqual({
      Admin: { ws: admin, home: true, excluded: false, write: false, bridge: false },
    });
    expect((await grants(ids.teamPage!)).Team).toMatchObject({ excluded: false, write: false });
    expect((await grants(ids.publicNote!)).Team).toMatchObject({ excluded: false });
    // The folder's share: a row on the folder, derived on the item.
    expect((await grants(ids.folder!)).Team).toMatchObject({ excluded: false, home: false });
    expect((await grants(ids.inFolder!)).Team).toMatchObject({ excluded: false });
    const [via] = await sql<{ v: string | null }[]>`
      select via_folder_id::text as v from item_grants where node_id = ${ids.inFolder!} and workspace_id = ${team}`;
    expect(via!.v).toBe(ids.folder);
    // Admin-only kinds: Admin only.
    expect(Object.keys(await grants(ids.email!))).toEqual(['Admin']);
    // T1: an app the team reads is homed in Team; Write follows read-only.
    expect(await grants(ids.teamApp!)).toEqual({
      Team: { ws: team, home: true, excluded: false, write: true, bridge: false },
    });
    expect((await grants(ids.roApp!)).Team).toMatchObject({ home: true, write: false });
    expect((await grants(ids.adminApp!)).Admin).toMatchObject({ home: true });
    // Personal items (W6b, 0267): homed in their author's private
    // workspace, that one grant only, Write off.
    const draft = await grants(ids.draft!);
    expect(Object.keys(draft)).toEqual(['m (only you)']);
    expect(draft['m (only you)']).toMatchObject({ home: true, excluded: false, write: false });
    const [h] = await sql<{ n: number }[]>`
      select count(*)::int as n from nodes
       where owner_id = ${owner} and home_ws is null`;
    expect(h!.n).toBe(0);
    expect(await drift()).toBe(0);
    // Membership: owner moderates both, the member moderates Team and its
    // private workspace (made by the fold for its draft).
    const users = await sql<{ ws: string; login: string; m: boolean }[]>`
      select workspace_id::text as ws, login_id::text as login, moderator as m from workspace_users`;
    expect(
      users
        .map(
          (u) =>
            `${u.ws === admin ? 'A' : u.ws === team ? 'T' : 'P'}:${u.login === owner ? 'o' : 'm'}:${u.m}`,
        )
        .sort(),
    ).toEqual(['A:o:true', 'P:m:true', 'T:m:true', 'T:o:true']);
  });

  it('attaches the assistants and connectors, and stamps R3 rows from the agent', async () => {
    const res = await sql<{ ws: string; type: string; ref: string; write: boolean }[]>`
      select workspace_id::text as ws, type, ref_id as ref, write from workspace_resources`;
    const has = (ws: string, type: string, ref: string) =>
      res.some((r) => r.ws === ws && r.type === type && r.ref === ref);
    expect(has(admin, 'assistant', ids.persona!)).toBe(true);
    expect(has(team, 'assistant', ids['team-responder']!)).toBe(true);
    expect(has(admin, 'connector', 'conn-admin') && has(admin, 'connector', 'conn-team')).toBe(
      true,
    );
    expect(has(team, 'connector', 'conn-team')).toBe(true);
    expect(has(team, 'connector', 'conn-admin') || has(admin, 'connector', 'plain')).toBe(false);
    // Team holds what a member may use today: not a connector that is off.
    expect(has(team, 'connector', 'conn-off')).toBe(false);
    expect(has(admin, 'connector', 'conn-off')).toBe(true);
    expect(res.find((r) => r.ws === team && r.ref === 'conn-team')?.write).toBe(true);
    const [t] = await sql<{ id: string; ws: string }[]>`
      insert into traces (owner_id, kind, agent_id) values (${owner}, 'responder_turn', ${ids['team-responder']!})
      returning id, workspace_id::text as ws`;
    expect(t!.ws).toBe(team);
    const [r] = await sql<{ ws: string }[]>`
      insert into tool_results (id, owner_id, trace_id, tool_slug, content, bytes)
      values (${randomUUID()}, ${owner}, ${t!.id}, 'x', 'y', 1) returning workspace_id::text as ws`;
    expect(r!.ws).toBe(team);
  });

  it('the reach diff fails on a planted gain and on a connector that differs from today', async () => {
    let fails: string[] = [];
    await sql
      .begin(async (tx) => {
        // A Team grant the level does not give (the reach diff compares
        // with the levels frozen at the switch).
        await tx`insert into item_grants (node_id, workspace_id) values (${ids.adminPage!}, ${team})`;
        await tx`delete from workspace_resources where workspace_id = ${team} and ref_id = 'conn-team'`;
        const rows = await tx<
          Row[]
        >`select * from mantle_ws_reach_diff() where section = 'reach-fail'`;
        fails = rows.map((r) => `${r.subject}: ${r.metric} ${r.n}`);
        throw new Error('roll back');
      })
      .catch(() => undefined);
    expect(fails.sort()).toEqual(
      [
        'login (member): gained items 1',
        'assistant:team: gained items 1',
        'connectors on Team: differ from what members may use today 1',
      ].sort(),
    );
  });

  it('no bridge: a level change is refused; a new item takes a home and its folder rows; an app switch writes no grant', async () => {
    await expect(
      sql`update nodes set audience = 'team' where id = ${ids.adminPage!}`,
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`update nodes set share_level = null where id = ${ids.folder!}`,
    ).rejects.toMatchObject({ code: '55000' });
    // New items: home Admin; in the shared folder Team too, from the folder.
    const fresh = await node('fresh', owner, 'page', 'pages', 'admin');
    expect(Object.keys(await grants(fresh))).toEqual(['Admin']);
    expect((await grants(fresh)).Admin).toMatchObject({ home: true });
    const placed = await node('placed', owner, 'page', 'pages.shared', 'admin');
    expect((await grants(placed)).Team).toMatchObject({ excluded: false, home: false });
    expect(await readWs(placed)).toEqual([admin, team].sort());
    // The folder's Team row goes: its items leave Team.
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${ids.folder!}::uuid], 'update')`;
      await tx`delete from item_grants where node_id = ${ids.folder!} and workspace_id = ${team}`;
    });
    expect((await grants(placed)).Team).toBeUndefined();
    expect((await grants(ids.inFolder!)).Team).toBeUndefined();
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${ids.folder!}::uuid], 'update')`;
      await tx`insert into item_grants (node_id, workspace_id) values (${ids.folder!}, ${team})`;
    });
    expect((await grants(placed)).Team).toMatchObject({ excluded: false });
    expect((await grants(ids.inFolder!)).Team).toMatchObject({ excluded: false });
    // An app's read-only switch is the app's, not a grant (the Team row's
    // Write is set in the Grant Access panel).
    await sql`update apps set data_read_only = true where node_id = ${ids.teamApp!}`;
    expect((await grants(ids.teamApp!)).Team).toMatchObject({ write: true });
    await sql`update apps set data_read_only = false where node_id = ${ids.teamApp!}`;
    expect(await drift()).toBe(0);
  });

  it('one statement that makes many items: every one homed, row written once', async () => {
    const made = await sql<{ id: string; x: string }[]>`
      insert into nodes (owner_id, type, title, path, audience)
      select ${owner}, 'page', 'bulk ' || g, (case when g % 2 = 0 then 'pages.shared' else 'pages' end)::ltree, 'admin'
        from generate_series(1, 20) g
      returning id, xmin::text as x`;
    const bulk = made.map((r) => r.id);
    const rows = await sql<{ id: string; r: string[]; x: string; h: string }[]>`
      select id, read_ws::text[] as r, xmin::text as x, home_ws::text as h from nodes
       where id = any(${`{${bulk.join(',')}}`}::uuid[]) order by title`;
    for (const r of rows) {
      expect(r.h).toBe(admin);
      // Written once: the BEFORE trigger set what the grants say.
      expect(r.x).toBe(made.find((m) => m.id === r.id)!.x);
    }
    expect(new Set(rows.map((r) => r.r.length))).toEqual(new Set([1, 2]));
    // One statement that changes many levels is refused whole.
    await expect(
      sql`update nodes set audience = 'team' where id = any(${`{${bulk.join(',')}}`}::uuid[])`,
    ).rejects.toMatchObject({ code: '55000' });
    expect(await drift()).toBe(0);
  });

  it('an item homed outside Admin keeps its home on a move; the folder passes its rows', async () => {
    // Re-homed the workspace way (W5): a Team home, no Admin row.
    const x = await node('wsItem', owner, 'page', 'pages', 'admin');
    await sql.begin(async (tx) => {
      await tx`delete from item_grants where node_id = ${x}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home) values (${x}, ${team}, true)`;
    });
    const before = await grants(x);
    expect(before).toEqual({
      Team: { ws: team, home: true, excluded: false, write: false, bridge: false },
    });
    expect(await readWs(x)).toEqual([team]);
    // A move into a folder: its Team home row unchanged, no Admin home. The
    // folder passes its own rows (S6, placing is accepting), so Admin
    // arrives as a row derived from the folder, never as a home.
    await sql`update nodes set path = 'pages.shared' where id = ${x}`;
    const moved = await grants(x);
    expect(moved.Team).toEqual(before.Team);
    expect(moved.Admin).toMatchObject({ home: false });
    const [via] = await sql<{ v: string | null }[]>`
      select via_folder_id::text as v from item_grants where node_id = ${x} and workspace_id = ${admin}`;
    expect(via!.v).toBe(ids.folder);
    await sql`delete from nodes where id = ${x}`;
  });

  it('a move follows the folder: one item, and a whole sub-folder, in and out of a team folder', async () => {
    const item = await node('mover', owner, 'page', 'pages', 'admin');
    expect((await grants(item)).Team).toBeUndefined();
    await sql`update nodes set path = 'pages.shared' where id = ${item}`;
    expect((await grants(item)).Team).toMatchObject({ excluded: false });
    expect(await readWs(item)).toEqual([admin, team].sort());
    await sql`update nodes set path = 'pages' where id = ${item}`;
    expect((await grants(item)).Team).toBeUndefined();
    expect(await readWs(item)).toEqual([admin]);
    // A sub-folder with an item, moved in one statement under the shared
    // folder and back.
    const sub = await node('sub', owner, 'branch', 'pages.sub', 'admin');
    const inSub = await node('inSub', owner, 'page', 'pages.sub', 'admin');
    await sql`update nodes set path = ('pages.shared' || subpath(path, 1))::ltree
               where owner_id = ${owner} and path <@ 'pages.sub'::ltree`;
    for (const id of [sub, inSub]) expect(await readWs(id)).toEqual([admin, team].sort());
    await sql`update nodes set path = ('pages' || subpath(path, 2))::ltree
               where owner_id = ${owner} and path <@ 'pages.shared.sub'::ltree`;
    for (const id of [sub, inSub]) expect(await readWs(id)).toEqual([admin]);
    expect(await drift()).toBe(0);
  });

  it('a login joins the workspaces only by name: no trigger on a new login or a role', async () => {
    const z = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${z}, 'z@example.invalid', 'x', 'member')`;
    const where = async () =>
      (
        await sql<
          { ws: string }[]
        >`select workspace_id::text as ws from workspace_users where login_id = ${z}`
      )
        .map((r) => (r.ws === admin ? 'A' : 'T'))
        .sort();
    expect(await where()).toEqual([]);
    // What POST /api/users does after the insert: a member joins nothing
    // (0286: no Team by itself).
    await sql`select mantle_bridge_login(${z})`;
    expect(await where()).toEqual([]);
    await sql`update auth.users set role = 'admin' where id = ${z}`;
    expect(await where()).toEqual([]);
    // An admin joins Admin only.
    await sql`select mantle_bridge_login(${z})`;
    expect(await where()).toEqual(['A']);
    const [e] = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_events where action = 'bridge.login' and subject->>'login' = ${z}`;
    expect(e!.n).toBe(1);
    await sql`delete from auth.users where id = ${z}`;
    expect(await where()).toEqual([]);
  });

  it('a fact with a source follows its node; a grant change writes no fact row', async () => {
    const [f] = await sql<{ id: string; x: string }[]>`
      select id, xmin::text as x from facts where source_node_id = ${ids.teamPage!}`;
    const sees = (ws: string[]) =>
      asUser(
        ws,
        owner,
        async (tx) => (await tx<{ id: string }[]>`select id from facts where id = ${f!.id}`).length,
      );
    expect(await sees([team])).toBe(1);
    const teamRow = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${ids.teamPage!}::uuid], 'update')`;
        await fn(tx);
      });
    await teamRow(
      (tx) =>
        tx`delete from item_grants where node_id = ${ids.teamPage!} and workspace_id = ${team}`,
    );
    expect(await sees([team])).toBe(0);
    expect(await sees([admin])).toBe(1);
    await teamRow(
      (tx) =>
        tx`insert into item_grants (node_id, workspace_id) values (${ids.teamPage!}, ${team})`,
    );
    expect(await sees([team])).toBe(1);
    const [after] = await sql<
      { x: string }[]
    >`select xmin::text as x from facts where id = ${f!.id}`;
    expect(after!.x).toBe(f!.x);
  });

  it('R7: a deleted source freezes a kept fact at its LAST access; the reap still drops the rest', async () => {
    // A Team grant by hand (a new item's level gives it nothing).
    const src = await node('src', owner, 'page', 'pages');
    await sql`insert into item_grants (node_id, workspace_id) values (${src}, ${team})`;
    const [f] = await sql<{ id: string }[]>`
      insert into facts (owner_id, content, kind, source_node_id)
      values (${owner}, 'kept', 'semantic', ${src}) returning id`;
    const [gone] = await sql<{ id: string }[]>`
      insert into facts (owner_id, content, kind, source_node_id)
      values (${owner}, 'reaped', 'factual', ${src}) returning id`;
    // The copy written at insert says Admin + Team; the source then narrows
    // to Admin. Only a freeze at delete time can know that.
    await sql`delete from item_grants where node_id = ${src} and workspace_id = ${team}`;
    await sql`delete from nodes where id = ${src}`;
    const [row] = await sql<{ s: string | null; r: string[] }[]>`
      select source_node_id as s, read_ws::text[] as r from facts where id = ${f!.id}`;
    expect(row!.s).toBeNull();
    expect(row!.r).toEqual([admin]);
    expect((await sql`select 1 from facts where id = ${gone!.id}`).length).toBe(0);
    const sees = (ws: string[]) =>
      asUser(ws, owner, async (tx) => (await tx`select 1 from facts where id = ${f!.id}`).length);
    expect(await sees([team])).toBe(0);
    expect(await sees([admin])).toBe(1);
    // Cleared by hand: the same freeze, from the source as it is now.
    const src2 = await node('src2', owner, 'page', 'pages');
    await sql`insert into item_grants (node_id, workspace_id) values (${src2}, ${team})`;
    const [g] = await sql<{ id: string }[]>`
      insert into facts (owner_id, content, kind, source_node_id)
      values (${owner}, 'cleared', 'semantic', ${src2}) returning id`;
    await sql`delete from item_grants where node_id = ${src2} and workspace_id = ${team}`;
    await sql`update facts set source_node_id = null where id = ${g!.id}`;
    const [row2] = await sql<
      { r: string[] }[]
    >`select read_ws::text[] as r from facts where id = ${g!.id}`;
    expect(row2!.r).toEqual([admin]);
  });

  it('chat facts map to Admin, stored or new; only the derivation writes the copy', async () => {
    const rows = await sql<{ r: string[] }[]>`
      select read_ws::text[] as r from facts where source_node_id is null and content = 'chat fact'`;
    expect(rows[0]!.r).toEqual([admin]);
    const [n] = await sql<{ r: string[] }[]>`
      insert into facts (owner_id, content, kind) values (${owner}, 'new chat fact', 'preference')
      returning read_ws::text[] as r`;
    expect(n!.r).toEqual([admin]);
    await expect(
      sql`update facts set read_ws = ${`{${team}}`}::uuid[] where content = 'new chat fact'`,
    ).rejects.toMatchObject({ code: '42501' });
  });
});
