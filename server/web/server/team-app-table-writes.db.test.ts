/**
 * A team app writes rows to a Table its workspace holds (task 2178377a,
 * 2026-10-22): the member-app rule (packages/tools runtime-policy.ts
 * memberAppRefusal) lets a team app call the five row writes the policy
 * marks `table-rows`, the verdict (member-app-tools.ts rule 6) runs one only
 * on a Table homed in a workspace that holds the app, and the write runs as
 * the running login in the app's scope, so the database's checks decide.
 *
 * On a migrated scratch database, through the one app tool broker
 * (lib/app-tool-broker.ts runAppToolBroker) as its routes configure it,
 * with the real verdict, gate, scope and table handlers, the actor check
 * and the edit check on. Only the Activity and error log rows are stood in.
 *
 *  1. a user of the holder workspace with Write on the Table: rows land
 *     (table_row_add, table_rows_add, table_cell_set) in its draft;
 *     a Moderator of its home writes a Table whose Write switch is off;
 *  2. the same app, a Table homed in another workspace (with Write granted
 *     to the holder, so the database alone would allow it): refused by the
 *     verdict, nothing lands;
 *  3. a user of the holder without Write on the Table and not a Moderator:
 *     refused by the item check, nothing lands;
 *  4. a shared link's run: refused (a link runs no built-in), nothing lands;
 *  5. a schema write and a row delete from a team app: still refused;
 *  6. an app the Admin workspace alone holds, run by the owner: admin rules,
 *     as before (a schema write runs).
 *
 * A team app's run scope only read before (withViewer); an allowed row
 * write now enters it as a write scope (withViewer's `writes`, only for a
 * login running an app), so the write goes through the login write gateway
 * with the app's scope and the database checks it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/team-app-table-writes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordAppAccess: vi.fn(),
  recordAppError: vi.fn(),
  recordShareAccess: vi.fn(),
}));

type Answer = { status: number; body: { ok: boolean; error?: string; output?: unknown } };

describe.skipIf(!URL)('a team app writes rows to a Table its workspace holds', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let broker: typeof import('@/lib/app-tool-broker');
  let dir = '';
  const tag = `tat${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A user of the holder workspace, not a Moderator. */
  const writer = randomUUID();
  /** A Moderator of the holder workspace. */
  const moderator = randomUUID();
  let adminWs = '';
  let holderWs = '';
  let otherWs = '';
  let teamApp = '';
  let adminApp = '';
  /** Tables by key: homed in the holder with Write on (`own`), homed in
   *  the holder with Write off (`readOnly`), homed in another workspace
   *  with Write granted to the holder (`elsewhere`), homed in Admin
   *  (`admin`). */
  const tables: Record<'own' | 'readOnly' | 'elsewhere' | 'admin', string> = {
    own: '',
    readOnly: '',
    elsewhere: '',
    admin: '',
  };
  const rowIds: Record<string, string> = {};
  const savedActorCheck = process.env.MANTLE_ACTOR_CHECK;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  const SLUGS = [
    'table_row_add',
    'table_rows_add',
    'table_cell_set',
    'table_column_add',
    'table_row_delete',
  ];

  /** `fn` in `login`'s request scope, as the session guard enters it for a
   *  POST (the tool broker route is one). */
  const inRequest = async <T>(login: string, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
    return m.runAsActor(m.loginActor(login, 'rw'), () =>
      m.runInRequestSlot(async () => {
        if (!m.enterRequestScope(scope, { writes: true, drafts: false })) {
          throw new Error('the request scope was not entered');
        }
        return fn();
      }),
    ) as Promise<T>;
  };

  const request = (slug: string, input: Record<string, unknown>) =>
    new Request('http://brain.invalid/api/apps/x/tool-broker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, input }),
    });

  const answer = async (res: Response): Promise<Answer> => ({
    status: res.status,
    body: (await res.json()) as Answer['body'],
  });

  /** A member's run of the Team-held app (lib/app-runner.ts memberToolBroker). */
  const memberCall = (login: string, slug: string, input: Record<string, unknown>) =>
    inRequest(login, async () =>
      answer(
        await broker.runAppToolBroker(request(slug, input), {
          via: 'member',
          ownerId: owner,
          runner: { loginId: login, name: 'Runner' },
          app: async () => ({ id: teamApp, manifest: { toolSlugs: SLUGS } }),
          system: (fn) => m.asSystem(fn, 'app-data'),
        }),
      ),
    );

  /** The owner's run (the tool broker route's Admin branch). */
  const ownerCall = (appId: string, slug: string, input: Record<string, unknown>) =>
    inRequest(owner, async () =>
      answer(
        await broker.runAppToolBroker(request(slug, input), {
          via: 'owner',
          ownerId: owner,
          runner: { loginId: owner, name: 'Owner' },
          app: async () => (await import('@mantle/content')).getAppRuntime(owner, appId),
        }),
      ),
    );

  /** A shared link's run (POST /s/:token/tool-broker, past its code gate). */
  const linkCall = (slug: string, input: Record<string, unknown>) =>
    m.asSystem(
      async () =>
        answer(
          await broker.runAppToolBroker(request(slug, input), {
            via: 'contact',
            ownerId: owner,
            share: { id: randomUUID(), contactId: randomUUID() },
            served: async () => [teamApp, tables.own],
            app: async () => ({ id: teamApp, manifest: { toolSlugs: SLUGS } }),
          }),
        ),
      'test',
    );

  /** The grid a Table's next reader of drafts sees (its draft, else the
   *  published workbook), as text. */
  const grid = async (id: string): Promise<string> =>
    m.asSystem(async () => {
      const { windowFile } = await import('../../../packages/tools/src/tables/common');
      const { readDocClipped } = await import('@mantle/tabledb');
      const abs = await windowFile(owner, id);
      return abs ? JSON.stringify(readDocClipped(abs, 500).doc) : '';
    }, 'test');

  /** Whether a Table has a draft (a write made one). */
  const hasDraft = async (id: string): Promise<boolean> =>
    (
      await x<{ d: boolean }>(
        sql`select draft_path is not null as d from tables where node_id = ${id}`,
      )
    )[0]?.d === true;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'team-app-table-writes-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    broker = await import('@/lib/app-tool-broker');
    const c = await import('@mantle/content');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${writer}, ${`${tag}-w@example.invalid`}, 'x', false, 'member', 'Writer'),
      (${moderator}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Moderator')`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    holderWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Holder`}) returning id::text`)
    )[0]!.id;
    otherWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Other`}) returning id::text`)
    )[0]!.id;
    // The two members are in the holder workspace only; the owner is in
    // Admin and the other workspace (it homes `elsewhere` there).
    await su(sql`delete from workspace_users where login_id in (${writer}, ${moderator})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${holderWs}, ${writer}, false),
      (${holderWs}, ${moderator}, true),
      (${otherWs}, ${owner}, true)`);
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    // An enabled team-level group holds the tools (rule 5).
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled)
      values (${owner}, ${`${tag}-tables`}, 'Tables', ${`{${SLUGS.join(',')}}`}::text[], 'team', true)`);

    const col = randomUUID();
    const make = async (key: keyof typeof tables) => {
      const row = randomUUID();
      const made = await m.asSystem(
        () =>
          m.withCreateHome({ createWs: adminWs, privateWs: null, quiet: true }, () =>
            c.createTable(owner, {
              title: `${tag} ${key}`,
              data: {
                columns: [{ id: col, name: 'Name', type: 'text' }],
                rows: [{ id: row, cells: { [col]: 'published row' } }],
              },
            }),
          ),
        'test',
      );
      tables[key] = made.id;
      rowIds[key] = row;
    };
    for (const key of Object.keys(tables) as (keyof typeof tables)[]) await make(key);
    /** Set an item's grants: [workspace, write, home]. */
    const grants = async (id: string, rows: [string, boolean, boolean][]) =>
      m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`delete from item_grants where node_id = ${id}`);
        for (const [ws, write, home] of rows) {
          await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
            values (${id}, ${ws}, ${write}, ${home})`);
        }
      });
    await grants(tables.own, [[holderWs, true, true]]);
    await grants(tables.readOnly, [[holderWs, false, true]]);
    await grants(tables.elsewhere, [
      [otherWs, true, true],
      [holderWs, true, false],
    ]);
    await grants(tables.admin, [[adminWs, true, true]]);

    // The apps: one the holder workspace holds (team rules), one the Admin
    // workspace alone holds (admin rules).
    const app = async (holds: [string, boolean, boolean][]) => {
      const id = randomUUID();
      await x(sql`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, 'app', ${`${tag} app`}, 'apps')`);
      await x(sql`insert into apps (node_id, manifest)
        values (${id}, ${JSON.stringify({ toolSlugs: SLUGS })}::jsonb)`);
      await grants(id, holds);
      return id;
    };
    teamApp = await app([
      [holderWs, true, true],
      [adminWs, false, false],
    ]);
    adminApp = await app([[adminWs, true, true]]);

    // The box's checks on, as an operator switches them.
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
  }, 240_000);

  afterAll(async () => {
    if (savedActorCheck === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = savedActorCheck;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('1. a user with Write on a Table the holder homes: the rows land in its draft', async () => {
    const one = await memberCall(writer, 'table_row_add', {
      table_id: tables.own,
      cells: { Name: `${tag} one` },
    });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.ok, JSON.stringify(one.body)).toBe(true);
    const many = await memberCall(writer, 'table_rows_add', {
      table_id: tables.own,
      rows: [{ Name: `${tag} two` }, { Name: `${tag} three` }],
    });
    expect(many.body.ok, JSON.stringify(many.body)).toBe(true);
    const cell = await memberCall(writer, 'table_cell_set', {
      table_id: tables.own,
      row_id: rowIds.own,
      column: 'Name',
      value: `${tag} changed`,
    });
    expect(cell.body.ok, JSON.stringify(cell.body)).toBe(true);
    const text = await grid(tables.own);
    for (const v of ['one', 'two', 'three', 'changed']) expect(text).toContain(`${tag} ${v}`);
  });

  it('1b. a Moderator of the home writes a Table whose Write switch is off', async () => {
    const res = await memberCall(moderator, 'table_row_add', {
      table_id: tables.readOnly,
      cells: { Name: `${tag} by moderator` },
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(await grid(tables.readOnly)).toContain(`${tag} by moderator`);
  });

  it('2. a Table homed in another workspace: refused by the verdict, nothing lands', async () => {
    const res = await memberCall(writer, 'table_row_add', {
      table_id: tables.elsewhere,
      cells: { Name: `${tag} elsewhere` },
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('homed in a workspace that holds this app');
    // No Table named: refused the same way (fail closed).
    const none = await memberCall(writer, 'table_row_add', { cells: { Name: 'x' } });
    expect(none.status).toBe(403);
    expect(none.body.error).toContain('names no Table');
    expect(await hasDraft(tables.elsewhere)).toBe(false);
    expect(await grid(tables.elsewhere)).not.toContain(`${tag} elsewhere`);
  });

  it('3. a user without Write on the Table, not a Moderator: refused, nothing lands', async () => {
    // Write off on the Table (1b's Moderator wrote it; this user is none).
    const res = await memberCall(writer, 'table_rows_add', {
      table_id: tables.readOnly,
      rows: [{ Name: `${tag} no right` }],
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/cannot change this item|Write on it|Moderator/i);
    expect(await grid(tables.readOnly)).not.toContain(`${tag} no right`);
  });

  it('4. a shared link run: refused, nothing lands', async () => {
    const res = await linkCall('table_row_add', {
      table_id: tables.own,
      cells: { Name: `${tag} by link` },
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('a shared link runs no built-in tools');
    expect(await grid(tables.own)).not.toContain(`${tag} by link`);
  });

  it('5. a schema write and a row delete from a team app: still refused', async () => {
    const before = await grid(tables.own);
    const column = await memberCall(writer, 'table_column_add', {
      table_id: tables.own,
      name: `${tag} column`,
      type: 'text',
    });
    expect(column.status).toBe(403);
    expect(column.body.error).toContain('changes data or reaches outside the brain');
    expect(column.body.error).toContain(t.TEAM_APP_TOOLS_ALLOWED);
    const del = await memberCall(writer, 'table_row_delete', {
      table_id: tables.own,
      row_id: rowIds.own,
    });
    expect(del.status).toBe(403);
    expect(del.body.error).toContain('changes data or reaches outside the brain');
    expect(await grid(tables.own)).toBe(before);
  });

  it('6. an app the Admin workspace alone holds, run by the owner: admin rules, as before', async () => {
    const res = await ownerCall(adminApp, 'table_column_add', {
      table_id: tables.admin,
      name: `${tag} admin column`,
      type: 'text',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(await grid(tables.admin)).toContain(`${tag} admin column`);
  });

  it('only a login running an app writes through withViewer', async () => {
    const noop = async () => 'ran';
    await expect(m.withViewer({ login: writer }, noop, { writes: true })).rejects.toThrow(
      /only a login running an app/,
    );
    await expect(m.withViewer({ agent: null }, noop, { writes: true })).rejects.toThrow(
      /only a login running an app/,
    );
    await expect(m.withViewer({ link: { served: [] } }, noop, { writes: true })).rejects.toThrow(
      /only a login running an app/,
    );
  });

  it('the publish warning says where a declared row write runs, and refuses the rest', async () => {
    const warnings = await m.asSystem(() => t.appToolWarnings(owner, teamApp), 'test');
    const of = (slug: string) => warnings.filter((w) => w.includes(`'${slug}'`));
    expect(of('table_row_add')[0]).toContain('homed in a workspace that holds this app');
    expect(of('table_column_add')[0]).toContain('changes data or reaches outside the brain');
    expect(of('table_row_delete')[0]).toContain(t.TEAM_APP_TOOLS_ALLOWED);
  });
});
