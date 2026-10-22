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
 * After the audit at ed3767f6d: the app's write scope reads the
 * drafts it may edit (an upsert twice leaves one row; an update and a cell
 * set reach a row the app added), a draft's row and byte ceilings and the
 * call's size ceiling, the Activity row names the Table and the row count,
 * a read-only login or a request that does not write writes nothing,
 * withViewer's `writes` takes only its request's own writer, the Table's
 * home is asked again where the write runs, an app two workspaces hold
 * writes nothing, and table_commit (Jason's yes) publishes the draft under
 * the same rule.
 *
 * After the delta audit (MED-1): a team app's table_commit waits out a
 * model pass (none while one is pending, none that runs a whole pass within
 * ten minutes of the last), a cell-only commit on a summarised Table is not
 * held, and an Admin app's or the owner's own commit is unchanged.
 *
 * A team app's run scope only read before (withViewer); an allowed Table
 * write now enters it as a write scope (withViewer's `writes`, only for a
 * login running an app in its own mutating request), so the write goes
 * through the login write gateway (opened in beforeAll) with the app's
 * scope and the database checks it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/team-app-table-writes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

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
  /** An app two workspaces beyond Admin hold: its run reads none. */
  let twoHolderApp = '';
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
    'table_rows_upsert',
    'table_row_update',
    'table_cell_set',
    'table_commit',
    'table_column_add',
    'table_row_delete',
  ];

  /** How the request runs: the login's actor mode, and whether the request
   *  writes (the tool broker route is a POST: it does). */
  type Req = { mode?: 'rw' | 'ro'; writes?: boolean };

  /** `fn` in `login`'s request scope, as the session guard enters it for a
   *  POST (requestMode(true): it reads drafts). */
  const inRequest = async <T>(login: string, fn: () => Promise<T>, req: Req = {}): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
    // The gate starts the slot as the login it found, a read key's login
    // read only (startsAs); the guard keeps that mode (nameRequestLogin).
    return m.runInRequestSlot(
      async () => {
        if (!m.enterRequestScope(scope, { writes: req.writes ?? true, drafts: true })) {
          throw new Error('the request scope was not entered');
        }
        return fn();
      },
      { startsAs: m.loginActor(login, req.mode ?? 'rw') },
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
  const memberCall = (
    login: string,
    slug: string,
    input: Record<string, unknown>,
    req: Req & { app?: string } = {},
  ) =>
    inRequest(
      login,
      async () =>
        answer(
          await broker.runAppToolBroker(request(slug, input), {
            via: 'member',
            ownerId: owner,
            runner: { loginId: login, name: 'Runner' },
            maxBytes: 8 * 1024 * 1024,
            app: async () => ({ id: req.app ?? teamApp, manifest: { toolSlugs: SLUGS } }),
            system: (fn) => m.asSystem(fn, 'app-data'),
          }),
        ),
      req,
    );

  /** The rows of a Table's grid (its draft, else published) whose Name is
   *  `name`. */
  const named = async (id: string, name: string): Promise<number> =>
    (await grid(id)).split(JSON.stringify(name)).length - 1;

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

  /** An ISO time `n` minutes ago. */
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  /** Stand in for the extractor (none runs here): the Table's summary and
   *  work stamps dropped, then `patch` merged onto its data. */
  const setData = async (id: string, patch: Record<string, unknown>) =>
    su(sql`update nodes set data = (coalesce(data, '{}'::jsonb)
        - 'summary' - 'summary_at' - 'index_work' - 'index_work_had_vector'
        - 'extract_completed_at' - 'extract_skipped') || ${JSON.stringify(patch)}::jsonb
      where id = ${id}`);

  /** The Table's work stamp (data.index_work), or null. */
  const indexWork = async (id: string): Promise<string | null> =>
    (
      await x<{ w: string | null }>(
        sql`select data->>'index_work' as w from nodes where id = ${id}`,
      )
    )[0]?.w ?? null;

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
    // The login write gateway, as web opens it (the audit's INFO): an app's
    // write goes to the write role, whose own checks answer it.
    m.openLoginWritePool({ max: 2 });
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
    twoHolderApp = await app([
      [holderWs, true, true],
      [otherWs, false, false],
    ]);

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
    expect(res.body.error).toContain('homed in the workspace that holds this app');
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

  it("only a login running an app, as its own request's writer, writes through withViewer", async () => {
    const noop = async () => 'ran';
    const forged = { loginId: writer.toLowerCase() };
    await expect(m.withViewer({ login: writer }, noop, { writes: forged })).rejects.toThrow(
      /only a login running an app/,
    );
    await expect(m.withViewer({ agent: null }, noop, { writes: forged })).rejects.toThrow(
      /only a login running an app/,
    );
    await expect(m.withViewer({ link: { served: [] } }, noop, { writes: forged })).rejects.toThrow(
      /only a login running an app/,
    );
    // A writer not made by appRunWriter, or another login's: refused.
    const app = { login: writer, app: { id: teamApp } };
    await expect(m.withViewer(app, noop, { writes: forged })).rejects.toThrow(/own login/);
    await inRequest(moderator, async () => {
      const other = m.appRunWriter();
      expect(other?.loginId).toBe(moderator.toLowerCase());
      await expect(m.withViewer(app, noop, { writes: other! })).rejects.toThrow(/own login/);
    });
    // appRunWriter: none for a read-only login, none in a request that
    // does not write.
    expect(await inRequest(writer, async () => m.appRunWriter(), { mode: 'ro' })).toBeNull();
    expect(await inRequest(writer, async () => m.appRunWriter(), { writes: false })).toBeNull();
  });

  it('a read-only login, or a request that does not write: refused, nothing lands', async () => {
    const ro = await memberCall(
      writer,
      'table_row_add',
      { table_id: tables.own, cells: { Name: `${tag} read only` } },
      { mode: 'ro' },
    );
    expect(ro.status).toBe(403);
    expect(ro.body.error).toContain('cannot change data');
    const read = await memberCall(
      writer,
      'table_row_add',
      { table_id: tables.own, cells: { Name: `${tag} no write` } },
      { writes: false },
    );
    expect(read.status).toBe(403);
    expect(read.body.error).toContain('cannot change data');
    expect(await named(tables.own, `${tag} read only`)).toBe(0);
    expect(await named(tables.own, `${tag} no write`)).toBe(0);
  });

  it('the draft is read back: an upsert twice leaves one row; update and cell set reach a row the app added', async () => {
    const up = { table_id: tables.own, key: ['Name'], rows: [{ Name: `${tag} upsert` }] };
    const first = await memberCall(writer, 'table_rows_upsert', up);
    expect(first.body.ok, JSON.stringify(first.body)).toBe(true);
    expect(first.body.output).toMatchObject({ added: 1 });
    const second = await memberCall(writer, 'table_rows_upsert', up);
    expect(second.body.ok, JSON.stringify(second.body)).toBe(true);
    expect(second.body.output).toMatchObject({ added: 0, unchanged: 1 });
    expect(await named(tables.own, `${tag} upsert`)).toBe(1);

    const added = await memberCall(writer, 'table_row_add', {
      table_id: tables.own,
      cells: { Name: `${tag} app row` },
    });
    expect(added.body.ok, JSON.stringify(added.body)).toBe(true);
    const rowId = (added.body.output as { row_id: string }).row_id;
    const upd = await memberCall(writer, 'table_row_update', {
      table_id: tables.own,
      row_id: rowId,
      cells: { Name: `${tag} app row updated` },
    });
    expect(upd.body.ok, JSON.stringify(upd.body)).toBe(true);
    const cell = await memberCall(writer, 'table_cell_set', {
      table_id: tables.own,
      row_id: rowId,
      column: 'Name',
      value: `${tag} app row set`,
    });
    expect(cell.body.ok, JSON.stringify(cell.body)).toBe(true);
    expect(await named(tables.own, `${tag} app row set`)).toBe(1);
    expect(await named(tables.own, `${tag} app row`)).toBe(0);
  });

  it('the app scope reads drafts only of Tables the login may edit', async () => {
    // The Moderator wrote readOnly's draft (1b); the writer has no Write on
    // it: in the app's write scope its draft column is not read.
    const seen = await inRequest(writer, async () => {
      const w = m.appRunWriter();
      return m.asSystem(
        () =>
          m.withViewer(
            { login: writer, app: { id: teamApp } },
            async () => {
              const { windowFile } = await import('../../../packages/tools/src/tables/common');
              const { readDocClipped } = await import('@mantle/tabledb');
              const abs = await windowFile(owner, tables.readOnly);
              return abs ? JSON.stringify(readDocClipped(abs, 500).doc) : '';
            },
            { writes: w! },
          ),
        'app-data',
      );
    });
    expect(seen).toContain('published row');
    expect(seen).not.toContain(`${tag} by moderator`);
  });

  it('the Activity row names the Table and the row count, not the cells', async () => {
    const { recordAppAccess } = await import('@mantle/content');
    (recordAppAccess as Mock).mockClear();
    const res = await memberCall(writer, 'table_rows_add', {
      table_id: tables.own,
      rows: [{ Name: `${tag} logged a` }, { Name: `${tag} logged b` }],
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const detail = (recordAppAccess as Mock).mock.calls.at(-1)?.[0]?.detail as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({
      slug: 'table_rows_add',
      write: true,
      table_id: tables.own,
      rows: 2,
    });
    expect(JSON.stringify(detail)).not.toContain('logged a');
  });

  it('the ceilings: a draft past its rows, a call past its bytes: refused, nothing lands', async () => {
    const saved = process.env.TABLE_IMPORT_MAX_ROWS;
    process.env.TABLE_IMPORT_MAX_ROWS = '3';
    try {
      const res = await memberCall(writer, 'table_rows_add', {
        table_id: tables.own,
        rows: [{ Name: `${tag} past the ceiling` }],
      });
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("ceiling of a team app's writes");
    } finally {
      if (saved === undefined) delete process.env.TABLE_IMPORT_MAX_ROWS;
      else process.env.TABLE_IMPORT_MAX_ROWS = saved;
    }
    expect(await named(tables.own, `${tag} past the ceiling`)).toBe(0);
    const big = await memberCall(writer, 'table_rows_add', {
      table_id: tables.own,
      rows: [{ Name: `${tag} big ${'x'.repeat(t.APP_TABLE_WRITE_MAX_BYTES)}` }],
    });
    expect(big.status).toBe(403);
    expect(big.body.error).toContain("the most a team app's Table write takes");
    expect((await grid(tables.own)).includes(`${tag} big`)).toBe(false);
  });

  it('the home is asked again where the write runs: a Table outside the app scope takes none', async () => {
    const c = await import('@mantle/content');
    const before = await hasDraft(tables.elsewhere);
    await expect(
      inRequest(writer, async () => {
        const w = m.appRunWriter();
        return m.asSystem(
          () =>
            m.withViewer(
              { login: writer, app: { id: teamApp } },
              () => c.applyTableOps(owner, tables.elsewhere, [{ op: 'row_add', cells: {} }]),
              { writes: w! },
            ),
          'app-data',
        );
      }),
    ).rejects.toThrow(/not allowed to edit/);
    expect(await hasDraft(tables.elsewhere)).toBe(before);
  });

  it('an app two workspaces beyond Admin hold writes no Table', async () => {
    const res = await memberCall(
      writer,
      'table_row_add',
      { table_id: tables.own, cells: { Name: `${tag} two holders` } },
      { app: twoHolderApp },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('is not one');
    expect(await named(tables.own, `${tag} two holders`)).toBe(0);
    const warnings = await m.asSystem(() => t.appToolWarnings(owner, twoHolderApp), 'test');
    expect(warnings.find((w) => w.includes("'table_row_add'"))).toContain('writes no Table here');
  });

  it('table_commit: refused elsewhere, without Write and on a link; publishes its own Table', async () => {
    const elsewhere = await memberCall(writer, 'table_commit', { id: tables.elsewhere });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error).toContain('homed in the workspace that holds this app');
    // The Moderator's draft on readOnly (1b): the writer may not publish it.
    expect(await hasDraft(tables.readOnly)).toBe(true);
    const noRight = await memberCall(writer, 'table_commit', { id: tables.readOnly });
    expect(noRight.body.ok).toBe(false);
    expect(noRight.body.error).toMatch(
      /cannot change this item|Write on it|Moderator|not allowed/i,
    );
    expect(await hasDraft(tables.readOnly)).toBe(true);
    const link = await linkCall('table_commit', { id: tables.own });
    expect(link.status).toBe(403);
    expect(link.body.error).toContain('a shared link runs no built-in tools');
    expect(await hasDraft(tables.own)).toBe(true);

    // No pass pending and the last long ago (no extractor runs here): the
    // commit wait (MED-1) has nothing to hold.
    await setData(tables.own, { extract_completed_at: minutesAgo(60) });
    const res = await memberCall(writer, 'table_commit', { id: tables.own });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(await hasDraft(tables.own)).toBe(false);
    const published = await grid(tables.own);
    for (const v of ['one', 'two', 'upsert', 'app row set'])
      expect(published).toContain(`${tag} ${v}`);
  });

  it("a team app's commit waits out a model pass (MED-1)", async () => {
    const draft = async (name: string) => {
      const r = await memberCall(writer, 'table_row_add', {
        table_id: tables.own,
        cells: { Name: `${tag} ${name}` },
      });
      expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    };
    const commit = () => memberCall(writer, 'table_commit', { id: tables.own });

    // The last commit had no summary: it stamped a whole pass, still pending.
    expect(await indexWork(tables.own)).toBe('extract');
    await draft('wait pending');
    const pending = await commit();
    expect(pending.body.ok).toBe(false);
    expect(pending.body.error).toContain('still being indexed');
    expect(await hasDraft(tables.own)).toBe(true);

    // The pass done two minutes ago, no summary (a whole pass again): held.
    await setData(tables.own, { extract_completed_at: minutesAgo(2) });
    const recent = await commit();
    expect(recent.body.ok).toBe(false);
    expect(recent.body.error).toContain('still being indexed');
    expect(await hasDraft(tables.own)).toBe(true);

    // Eleven minutes on: the commit lands and stamps the next pass.
    await setData(tables.own, { extract_completed_at: minutesAgo(11) });
    const later = await commit();
    expect(later.body.ok, JSON.stringify(later.body)).toBe(true);
    expect(await hasDraft(tables.own)).toBe(false);
    expect(await grid(tables.own)).toContain(`${tag} wait pending`);
    expect(await indexWork(tables.own)).toBe('extract');

    // A summarised Table a minute after its pass: a cell-only commit (a
    // re-embed, no model call) is not held. A cell set, not a row add: the
    // shape hash buckets the row count, so a row add across a power of ten
    // is a whole pass, and held.
    await setData(tables.own, { summary: 'Rows by name.', extract_completed_at: minutesAgo(1) });
    const set = await memberCall(writer, 'table_cell_set', {
      table_id: tables.own,
      row_id: rowIds.own,
      column: 'Name',
      value: `${tag} wait cells`,
    });
    expect(set.body.ok, JSON.stringify(set.body)).toBe(true);
    const cells = await commit();
    expect(cells.body.ok, JSON.stringify(cells.body)).toBe(true);
    expect(await hasDraft(tables.own)).toBe(false);
    expect(await indexWork(tables.own)).toBe('embed');
  });

  it('an Admin app or a UI commit in the same states: unchanged', async () => {
    const c = await import('@mantle/content');
    // The Admin app, a pass pending.
    const add = await ownerCall(adminApp, 'table_row_add', {
      table_id: tables.admin,
      cells: { Name: `${tag} admin wait` },
    });
    expect(add.body.ok, JSON.stringify(add.body)).toBe(true);
    await setData(tables.admin, { index_work: 'extract', extract_completed_at: minutesAgo(1) });
    const admin = await ownerCall(adminApp, 'table_commit', { id: tables.admin });
    expect(admin.body.ok, JSON.stringify(admin.body)).toBe(true);
    expect(await hasDraft(tables.admin)).toBe(false);

    // The owner's own commit (the UI's), a pass pending, then no summary
    // and a pass a minute ago.
    for (const data of [
      { index_work: 'extract' },
      { extract_completed_at: minutesAgo(1) },
    ] as Record<string, unknown>[]) {
      await inRequest(owner, () =>
        c.applyTableOps(owner, tables.admin, [{ op: 'row_add', cells: {} }]),
      );
      expect(await hasDraft(tables.admin)).toBe(true);
      await setData(tables.admin, data);
      const out = await inRequest(owner, () => c.commitTable(owner, tables.admin));
      expect(out).not.toBeNull();
      expect(await hasDraft(tables.admin)).toBe(false);
    }
  });

  it('the publish warning says where a declared row write runs, and refuses the rest', async () => {
    const warnings = await m.asSystem(() => t.appToolWarnings(owner, teamApp), 'test');
    const of = (slug: string) => warnings.filter((w) => w.includes(`'${slug}'`));
    expect(of('table_row_add')[0]).toContain('homed in the workspace that holds this app');
    expect(of('table_commit')[0]).toContain('homed in the workspace that holds this app');
    expect(of('table_column_add')[0]).toContain('changes data or reaches outside the brain');
    expect(of('table_row_delete')[0]).toContain(t.TEAM_APP_TOOLS_ALLOWED);
  });
});
