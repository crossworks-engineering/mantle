/**
 * A team app calls the documents tools (2026-11-01): the member-app rule
 * (packages/tools runtime-policy.ts memberAppRefusal) lets a team app call
 * pdf_render, screenshot_render, office_to_pdf and pdf_tools (policy
 * memberApp 'documents'); the tool reads its inputs in the app's scope,
 * prints no page of the brain, and saves its file only in the workspace
 * that holds the app, for a user who moderates it (builtins-documents.ts
 * teamAppSaveRefusal), or hands the bytes back to the app.
 *
 * On a migrated scratch database, through the one app tool broker
 * (lib/app-tool-broker.ts runAppToolBroker) as its routes configure it,
 * with the real verdict, gate, scope, documents runner and file landing,
 * the actor check and the edit check on. The engine itself is stood in by
 * a fetch stub on its URL (it answers a fixed PDF); the Activity and error
 * log rows are stood in.
 *
 *  1. a Moderator of the holder: the PDF lands at the top of Files, homed
 *     in the holder; a user of the holder reads it back with file_read
 *     bytes (the same caps), in the app's scope;
 *  2. a user of the holder who is not a Moderator: the save is refused
 *     (pass bytes: true), nothing lands; with bytes: true the PDF comes
 *     back, nothing lands;
 *  3. an input the app's scope cannot read (a file homed in Admin): refused
 *     before the engine is called;
 *  4. a page print (node_id): refused, the engine is not called;
 *  5. an admin who runs the team app (team rules, not in the holder): no
 *     file lands, never in Admin;
 *  6. a read-only login: the save is refused;
 *  7. a shared link's run: refused (a link runs no built-in);
 *  8. an app the Admin workspace alone holds, run by the owner: lands where
 *     an admin's export lands, as before.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/team-app-documents.db.test.ts
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

/** The engine's stand-in answer. */
const PDF = Buffer.from('%PDF-1.7 team app report');
const ENGINE = 'http://gotenberg.invalid';

describe.skipIf(!URL)('a team app calls the documents tools', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let broker: typeof import('@/lib/app-tool-broker');
  let dir = '';
  const tag = `tad${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A user of the holder workspace, not a Moderator. */
  const member = randomUUID();
  /** A Moderator of the holder workspace. */
  const moderator = randomUUID();
  let adminWs = '';
  let holderWs = '';
  let teamApp = '';
  let adminApp = '';
  let adminFile = '';
  let page = '';
  /** Calls the engine stand-in took. */
  let engineCalls = 0;
  const savedEnv: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  const SLUGS = ['pdf_render', 'screenshot_render', 'office_to_pdf', 'pdf_tools', 'file_read'];

  type Req = { mode?: 'rw' | 'ro'; writes?: boolean };

  /** `fn` in `login`'s request scope, as the session guard enters it for a
   *  POST (requestMode(true): it reads drafts). */
  const inRequest = async <T>(login: string, fn: () => Promise<T>, req: Req = {}): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
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
  const memberCall = (login: string, slug: string, input: Record<string, unknown>, req: Req = {}) =>
    inRequest(
      login,
      async () =>
        answer(
          await broker.runAppToolBroker(request(slug, input), {
            via: 'member',
            ownerId: owner,
            runner: { loginId: login, name: 'Runner' },
            maxBytes: 8 * 1024 * 1024,
            app: async () => ({ id: teamApp, manifest: { toolSlugs: SLUGS } }),
            system: (fn) => m.asSystem(fn, 'app-data'),
          }),
        ),
      req,
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
            served: async () => [teamApp],
            app: async () => ({ id: teamApp, manifest: { toolSlugs: SLUGS } }),
          }),
        ),
      'test',
    );

  /** The files the engine made: their home and folder. */
  const made = async (): Promise<{ id: string; home: string | null; path: string }[]> =>
    x(sql`select id::text, home_ws::text as home, path::text from nodes
      where owner_id = ${owner} and type = 'file' and data->>'documentsRoute' is not null
      order by created_at`);

  beforeAll(async () => {
    for (const k of ['GOTENBERG_URL', 'GOTENBERG_PASSWORD', 'MANTLE_ACTOR_CHECK']) {
      savedEnv[k] = process.env[k];
    }
    // The engine on (a process outside compose: the password alone decides)
    // and answering one PDF on its URL; every other fetch is the real one.
    process.env.GOTENBERG_URL = ENGINE;
    process.env.GOTENBERG_PASSWORD = 'test-password';
    vi.stubGlobal('fetch', async (input: RequestInfo | globalThis.URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      if (!url.startsWith(ENGINE)) return realFetch(input, init);
      engineCalls += 1;
      return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
    });

    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'team-app-documents-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    t = await import('@mantle/tools');
    broker = await import('@/lib/app-tool-broker');
    const c = await import('@mantle/content');
    const files = await import('@mantle/files');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${member}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'Member'),
      (${moderator}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Moderator')`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    holderWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Holder`}) returning id::text`)
    )[0]!.id;
    // The two members are in the holder workspace only; the owner is in
    // Admin alone.
    await su(sql`delete from workspace_users where login_id in (${member}, ${moderator})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${holderWs}, ${member}, false),
      (${holderWs}, ${moderator}, true)`);
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    // An enabled team-level group holds the tools (rule 5).
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled)
      values (${owner}, ${`${tag}-docs`}, 'Documents', ${`{${SLUGS.join(',')}}`}::text[], 'team', true)`);

    // An Admin-only file and page: the app's scope reads neither.
    await m.asSystem(() => files.ensureFilesRootBranch(owner), 'test');
    await m.asSystem(
      () =>
        m.withCreateHome({ createWs: adminWs, privateWs: null, quiet: true }, async () => {
          adminFile = (
            await files.upsertFile({
              ownerId: owner,
              parentPath: 'files',
              filename: `${tag}-private.docx`,
              bytes: Buffer.from('admin only'),
            })
          ).id;
          page = (await c.createPage(owner, { title: `${tag} page` })).id;
        }),
      'test',
    );

    /** Set an item's grants: [workspace, write, home]. */
    const grants = async (id: string, rows: [string, boolean, boolean][]) =>
      m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`delete from item_grants where node_id = ${id}`);
        for (const [ws, write, home] of rows) {
          await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
            values (${id}, ${ws}, ${write}, ${home})`);
        }
      });
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

    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('1. a Moderator: the PDF lands in the holder, and the app reads it back with file_read bytes', async () => {
    const res = await memberCall(moderator, 'pdf_render', {
      html: '<h1>Report</h1>',
      filename: `${tag}-report`,
    });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const out = res.body.output as { file_id: string; landedIn: { id: string } | null };
    expect(out.landedIn?.id).toBe(holderWs);
    const rows = await made();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.file_id, home: holderWs, path: 'files' });
    // A user of the holder who is no Moderator reads it in the app's scope.
    const read = await memberCall(member, 'file_read', { file_id: out.file_id, bytes: true });
    expect(read.body.ok, JSON.stringify(read.body)).toBe(true);
    expect((read.body.output as { content_base64: string }).content_base64).toBe(
      PDF.toString('base64'),
    );
  });

  it('2. not a Moderator: the save is refused, nothing lands; bytes: true hands it back', async () => {
    const before = (await made()).length;
    const res = await memberCall(member, 'pdf_render', { html: '<h1>x</h1>' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('needs a user who moderates it');
    expect(res.body.error).toContain('Pass bytes: true');
    const bytes = await memberCall(member, 'pdf_render', { html: '<h1>x</h1>', bytes: true });
    expect(bytes.body.ok, JSON.stringify(bytes.body)).toBe(true);
    expect(bytes.body.output).toMatchObject({
      mime_type: 'application/pdf',
      size_bytes: PDF.length,
      content_base64: PDF.toString('base64'),
    });
    expect((await made()).length).toBe(before);
  });

  it("3. an input the app's scope cannot read: refused before the engine runs", async () => {
    const calls = engineCalls;
    const res = await memberCall(moderator, 'office_to_pdf', {
      file_ids: [adminFile],
      bytes: true,
    });
    expect(res.body.ok).toBe(false);
    expect(engineCalls).toBe(calls);
  });

  it('4. a page print (node_id): refused, the engine is not called', async () => {
    const calls = engineCalls;
    const res = await memberCall(moderator, 'pdf_render', { node_id: page, bytes: true });
    expect(res.body.ok).toBe(false);
    expect(engineCalls).toBe(calls);
  });

  it('5. an admin who runs the team app (not in the holder): no file lands, never in Admin', async () => {
    const before = (await made()).length;
    const res = await ownerCall(teamApp, 'pdf_render', { html: '<h1>x</h1>' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('no workspace to land in');
    expect((await made()).length).toBe(before);
  });

  it('6. a read-only login: the save is refused', async () => {
    const before = (await made()).length;
    const res = await memberCall(moderator, 'pdf_render', { html: '<h1>x</h1>' }, { mode: 'ro' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("can't save a file");
    expect((await made()).length).toBe(before);
  });

  it("7. a shared link's run: refused, a link runs no built-in", async () => {
    const calls = engineCalls;
    const res = await linkCall('pdf_render', { html: '<h1>x</h1>', bytes: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('a shared link runs no built-in tools');
    expect(engineCalls).toBe(calls);
  });

  it("8. an app the Admin workspace alone holds: lands where an admin's export lands", async () => {
    const res = await ownerCall(adminApp, 'pdf_render', { html: '<h1>x</h1>' });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const id = (res.body.output as { file_id: string }).file_id;
    const row = (await made()).find((r) => r.id === id);
    expect(row?.home).toBe(adminWs);
    expect(row?.path).toMatch(/^files\.auto_filed\.exports/);
  });
});
