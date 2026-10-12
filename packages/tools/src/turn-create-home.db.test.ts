/**
 * Where a create from an assistant turn lands (workspaces arch A0, F12), on
 * a scratch brain the workspaces migration made live, through dispatchTool
 * in a turn scope as the tool loop runs it:
 *
 *  - a workspace assistant's turn, for a login that moderates the
 *    workspace: the workspace;
 *  - the same turn for a login that only reads it: the login's private
 *    workspace (no folder named);
 *  - the Admin assistant's turn, the same rule: an Admin user who moderates
 *    Admin lands in Admin, even in a folder homed in Team (the folder only
 *    passes its grants); one who does not, in the folder's home.
 *
 * Before A0 a turn named no home, so the first two landed in Admin.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/turn-create-home.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('assistant turn creates follow the home rule (A0)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('./index');
  const owner = randomUUID();
  const mod = randomUUID(); // a Moderator of Team
  const reader = randomUUID(); // a user of Team, no Moderator
  const adm2 = randomUUID(); // an Admin user, no Moderator of Admin
  const tag = `tch${randomUUID().slice(0, 6)}`;
  let team = '';
  let admin = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const noteCreate = {
    slug: 'note_create',
    name: 'note_create',
    description: 'note_create',
    handler: { kind: 'builtin', ref: 'note_create' },
    inputSchema: { type: 'object', properties: {} },
    requiresConfirm: false,
    externalAccess: null,
  } as unknown as Tool;

  const builtin = (slug: string) =>
    ({
      ...noteCreate,
      slug,
      name: slug,
      handler: { kind: 'builtin', ref: slug },
    }) as unknown as Tool;
  /** Make a note (or, with `folder`, a page in that pages folder) from a
   *  turn of `ws` that answers `login`; its home. */
  const createIn = async (ws: string, login: string, modWs: string[], folder?: string) => {
    const title = `${tag} ${randomUUID().slice(0, 8)}`;
    const res = await m.withTurnScope(
      { kind: 'assistant', loginId: login, ws: [ws], modWs },
      () =>
        tools.dispatchTool(
          folder ? builtin('page_create') : noteCreate,
          // confirm: the folder's grants make it visible to more workspaces.
          folder
            ? { title, markdown: 'x', folder_id: folder, confirm: true }
            : { title, content: 'x' },
          {
            ownerId: owner,
            surface:
              ws === admin ? { kind: 'web', loginId: login } : { kind: 'team', loginId: login },
          },
        ),
      { writes: true },
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    const rows = await x<{ home: string | null }>(sql`
      select g.workspace_id::text as home from nodes n
        join item_grants g on g.node_id = n.id and g.is_home
       where n.title = ${title}`);
    return rows[0]?.home ?? null;
  };
  /** The workspaces an item titled like the last one made is granted to. */
  const grantsOf = async (home: string | null) =>
    (
      await x<{ ws: string }>(sql`
        select g.workspace_id::text as ws from item_grants g
          join item_grants h on h.node_id = g.node_id and h.is_home and h.workspace_id = ${home}
          join nodes n on n.id = g.node_id
         where n.title like ${`${tag} %`} and n.type = 'page' and not g.excluded
         order by n.created_at desc`)
    ).map((r) => r.ws);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    // The disk stores the table, file and app creates write to.
    const dir = mkdtempSync(join(tmpdir(), 'turn-home-'));
    process.env.TABLE_DB_DIR = join(dir, 'tables');
    process.env.APP_DB_DIR = join(dir, 'apps');
    process.env.MANTLE_FILES_ROOT = join(dir, 'files');
    m = await import('@mantle/db');
    tools = await import('./index');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin'),
      (${mod}, ${`${tag}-m@example.invalid`}, 'x', false, 'member'),
      (${reader}, ${`${tag}-r@example.invalid`}, 'x', false, 'member'),
      (${adm2}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const wsRows = await x<{ id: string; key: string }>(sql`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`);
    team = wsRows.find((r) => r.key === 'team')!.id;
    admin = wsRows.find((r) => r.key === 'admin')!.id;
    await x(sql`update workspace_users set moderator = (login_id = ${mod})
                 where workspace_id = ${team} and login_id in (${mod}, ${reader})`);
    await x(sql`update workspace_users set moderator = false
                 where workspace_id = ${admin} and login_id = ${adm2}`);
    // The kind roots a fresh brain makes on the first read of a tree.
    for (const root of ['files', 'notes', 'pages', 'tasks', 'events', 'tables', 'apps', 'recall']) {
      await x(sql`insert into nodes (owner_id, type, title, path)
                  select ${owner}, 'branch', ${root}, ${root}::ltree
                   where not exists (select 1 from nodes where owner_id = ${owner}
                                       and path = ${root}::ltree and type = 'branch')`);
    }
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${team}, ${adm2}, true)
                on conflict (workspace_id, login_id) do update set moderator = true`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it("a Moderator's create in a workspace turn lands in that workspace", async () => {
    expect(await createIn(team, mod, [team])).toBe(team);
  });

  it("a reader's create in a workspace turn lands in its private workspace", async () => {
    const home = await createIn(team, reader, []);
    const own = await x<{ ws: string }>(sql`
      select workspace_id::text as ws from private_workspaces where login_id = ${reader}`);
    expect(own[0]?.ws).toBeTruthy();
    expect(home).toBe(own[0]!.ws);
  });

  /** Every create tool kind a workspace holds that a workspace turn may
   *  run (A0 fix round 2, L-2): its input, and the node type it makes. */
  const CREATES: Array<[string, (name: string) => Record<string, unknown>, string]> = [
    ['page_create', (n) => ({ title: n, markdown: 'x' }), 'page'],
    ['table_create', (n) => ({ title: n }), 'table'],
    ['file_create', (n) => ({ parent_path: 'files', filename: `${n}.md`, content: 'x' }), 'file'],
    ['event_create', (n) => ({ title: n, startsAt: '2026-11-01T10:00:00Z' }), 'event'],
    ['task_create', (n) => ({ title: n }), 'task'],
  ];

  it.each(CREATES)('%s from a workspace turn follows the home rule', async (slug, input, type) => {
    const own = async () =>
      (
        await x<{ ws: string }>(sql`
          select workspace_id::text as ws from private_workspaces where login_id = ${reader}`)
      )[0]?.ws;
    for (const [login, modWs] of [
      [mod, [team]],
      [reader, []],
    ] as const) {
      const token = `${tag}${randomUUID().slice(0, 6)}`;
      const res = await m.withTurnScope(
        { kind: 'assistant', loginId: login, ws: [team], modWs: [...modWs] },
        () =>
          tools.dispatchTool(builtin(slug), input(token), {
            ownerId: owner,
            surface: { kind: 'team', loginId: login },
          }),
        { writes: true },
      );
      expect(
        res.ok,
        `${slug} as ${login === mod ? 'mod' : 'reader'}: ${res.ok ? '' : res.error}`,
      ).toBe(true);
      const rows = await x<{ home: string | null }>(sql`
        select g.workspace_id::text as home from nodes n
          join item_grants g on g.node_id = n.id and g.is_home
         where n.type = ${type}::node_type and n.title ilike ${`%${token}%`}
         order by n.created_at desc limit 1`);
      expect(rows[0]?.home, `${slug} as ${login === mod ? 'mod' : 'reader'}`).toBe(
        login === mod ? team : await own(),
      );
    }
  });

  /** The owner-only create tools: refused in any turn outside the Admin
   *  workspace, so their turn home is the Admin assistant's, Admin. */
  const OWNER_ONLY_CREATES: Array<[string, (name: string) => Record<string, unknown>, string]> = [
    ['tree_folder_create', (n) => ({ kind: 'notes', name: n }), 'branch'],
    ['app_create', (n) => ({ name: n }), 'app'],
    ['recall_map_create', (n) => ({ title: n, enter_when: 'testing the home rule' }), 'recall'],
  ];

  it.each(OWNER_ONLY_CREATES)(
    '%s: refused in a workspace turn, Admin from the Admin turn',
    async (slug, input, type) => {
      const token = `${tag}${randomUUID().slice(0, 6)}`;
      const refused = await m.withTurnScope(
        { kind: 'assistant', loginId: mod, ws: [team], modWs: [team] },
        () =>
          tools.dispatchTool(builtin(slug), input(token), {
            ownerId: owner,
            surface: { kind: 'team', loginId: mod },
          }),
        { writes: true },
      );
      expect(refused.ok, slug).toBe(false);
      const res = await m.withTurnScope(
        { kind: 'assistant', loginId: owner, ws: [admin], modWs: [admin] },
        () =>
          tools.dispatchTool(builtin(slug), input(token), {
            ownerId: owner,
            surface: { kind: 'web', loginId: owner },
          }),
        { writes: true },
      );
      expect(res.ok, `${slug}: ${res.ok ? '' : res.error}`).toBe(true);
      const rows = await x<{ home: string | null }>(sql`
        select g.workspace_id::text as home from nodes n
          join item_grants g on g.node_id = n.id and g.is_home
         where n.type = ${type}::node_type and n.title ilike ${`%${token}%`}
         order by n.created_at desc limit 1`);
      expect(rows[0]?.home, slug).toBe(admin);
    },
  );

  it('a read in a turn does not make the private workspace; a create does (L-3)', async () => {
    const fresh = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role)
                values (${fresh}, ${`${tag}-f@example.invalid`}, 'x', false, 'member')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${team}, ${fresh}, false)`);
    const count = async () =>
      (
        await x<{ n: number }>(sql`
          select count(*)::int as n from private_workspaces where login_id = ${fresh}`)
      )[0]!.n;
    const turn = <T>(fn: () => Promise<T>) =>
      m.withTurnScope({ kind: 'assistant', loginId: fresh, ws: [team], modWs: [] }, fn, {
        writes: true,
      });
    const ctx = { ownerId: owner, surface: { kind: 'team' as const, loginId: fresh } };
    await turn(() => tools.dispatchTool(builtin('task_list'), {}, ctx));
    expect(await count()).toBe(0);
    await turn(() => tools.dispatchTool(builtin('task_create'), { title: `${tag} f` }, ctx));
    expect(await count()).toBe(1);
  });

  it('a Team reader with no private workspace: any write tool makes it; export_node is refused (M-a)', async () => {
    const fresh = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role)
                values (${fresh}, ${`${tag}-g@example.invalid`}, 'x', false, 'member')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${team}, ${fresh}, false)`);
    const count = async () =>
      (
        await x<{ n: number }>(sql`
          select count(*)::int as n from private_workspaces where login_id = ${fresh}`)
      )[0]!.n;
    const turn = <T>(fn: () => Promise<T>) =>
      m.withTurnScope({ kind: 'assistant', loginId: fresh, ws: [team], modWs: [] }, fn, {
        writes: true,
      });
    const ctx = { ownerId: owner, surface: { kind: 'team' as const, loginId: fresh } };
    // A note homed in Team with Write on for Team: the reader edits it.
    const note = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${note}, ${owner}, 'note', ${`${tag} team rw note`}, 'notes')`);
    await m.withHeads([note], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${note}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${note}, ${team}, true)`);
    });
    await m.withHeads([note], 'update', async (tx) => {
      await tx.execute(sql`update item_grants set write = true where node_id = ${note}`);
    });
    // export_node is Admin-only: refused in a Team turn, nothing made.
    const exported = await turn(() =>
      tools.dispatchTool(builtin('export_node'), { node_id: note }, ctx),
    );
    expect(exported.ok).toBe(false);
    expect(await count()).toBe(0);
    // A write tool that is not on the create list still makes it, since it
    // is not readOnly.
    expect(tools.CREATE_TOOL_SLUGS.has('note_update')).toBe(false);
    const res = await turn(() =>
      tools.dispatchTool(builtin('note_update'), { id: note, title: `${tag} renamed` }, ctx),
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(await count()).toBe(1);
  });

  it("an Admin user's create in the Admin assistant's turn lands in Admin", async () => {
    expect(await createIn(admin, owner, [admin])).toBe(admin);
  });

  it('the Admin assistant follows the same rule in a Team folder (CEO, 2026-10-12)', async () => {
    // A pages folder homed in Team and editable from Admin (the pages root first: a fresh brain
    // makes it on the first read of the tree).
    await x(sql`insert into nodes (owner_id, type, title, path)
                select ${owner}, 'branch', 'Pages', 'pages'
                 where not exists (select 1 from nodes where owner_id = ${owner}
                                     and path = 'pages'::ltree and type = 'branch')`);
    const name = `${tag} team folder`;
    const made = await m.withTurnScope(
      { kind: 'assistant', loginId: owner, ws: [admin], modWs: [admin] },
      () =>
        tools.dispatchTool(
          builtin('tree_folder_create'),
          { kind: 'pages', name },
          { ownerId: owner, surface: { kind: 'web', loginId: owner } },
        ),
      { writes: true },
    );
    expect(made.ok, made.ok ? '' : made.error).toBe(true);
    const [folder] = await x<{ id: string }>(
      sql`select id::text as id from nodes where title = ${name} and type = 'branch'`,
    );
    await m.withHeads([folder!.id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${folder!.id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${folder!.id}, ${team}, true)`);
      // Granted to Admin with Write on: Admin users may file in it.
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                           values (${folder!.id}, ${admin}, true)`);
    });
    // The confirm says where it is homed and who only reads it, by the
    // workspaces' names (A0 fix round 3, L-c).
    const names = await x<{ id: string; name: string }>(
      sql`select id::text as id, name from workspaces where id in (${admin}, ${team})`,
    );
    const nameOf = (id: string) => names.find((w) => w.id === id)!.name;
    const asked = await m.withTurnScope(
      { kind: 'assistant', loginId: owner, ws: [admin], modWs: [admin] },
      () =>
        tools.dispatchTool(
          builtin('page_create'),
          { title: `${tag} unconfirmed`, markdown: 'x', folder_id: folder!.id },
          { ownerId: owner, surface: { kind: 'web', loginId: owner } },
        ),
      { writes: true },
    );
    expect(asked.ok).toBe(false);
    expect(asked.ok ? '' : asked.error).toContain(
      `This will be homed in ${nameOf(admin)}. ${nameOf(team)} can read it (not edit).`,
    );
    // A Moderator of Admin: the page homes in Admin, the folder passes Team.
    expect(await createIn(admin, owner, [admin], folder!.id), 'owner').toBe(admin);
    expect(await grantsOf(admin)).toContain(team);
    // An Admin user who does not moderate Admin: the folder's home.
    expect(await createIn(admin, adm2, [], folder!.id), 'adm2').toBe(team);
  });
});
