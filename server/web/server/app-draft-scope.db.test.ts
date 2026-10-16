/**
 * An app's draft, read under the row lock, is the draft the caller's scope
 * reads (draft-read.ts): the edit rule comes from the scope the code runs
 * in, never from the settings of the connection the transaction landed on.
 * A login's write transaction may run on the plain system pool (the actor
 * check off, the documented default; a gap rerun in warn), which carries no
 * mantle.ws or mantle.mod_ws, so a rule read from those settings saw no
 * draft there: app_build answered "the source changed while it was
 * building" every time, app_file_write dropped every other draft file and
 * a publish shipped nothing.
 *
 * On a migrated scratch database, for the owner, an Admin user who is not
 * the owner, a Moderator of the app's home and a user with a Write grant,
 * with the actor check off, warn and on and the edit check off and warn:
 *
 *  - through the MCP surface (prepareCallerTools + registerPreparedTools,
 *    as /api/mcp serves it): app_source_set with several files (about
 *    40 KB), app_file_write keeps the other draft files, app_build, then
 *    app_update and app_publish, which ships the draft;
 *  - through the real web app with a session: the editor's save over the
 *    stamp it read, Preview's build and Commit;
 *  - the stale check is as strict as before: a build of source that
 *    changed meanwhile is refused, on the MCP path built again from the
 *    new source and recorded only for it.
 *
 * The object store and esbuild are stubbed (a build's code names a hash of
 * its source); network is stubbed. The full run covers every actor mode,
 * test:actor-off only off, test:actor-on only on.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/app-draft-scope.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Every build the stubbed esbuild ran, and a one-shot hook run inside a
 *  build (a concurrent edit). */
const builds = vi.hoisted(() => ({
  done: [] as { source: unknown; code: string }[],
  during: null as null | (() => Promise<void>),
}));

vi.mock('@mantle/app-build', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/app-build')>();
  return {
    ...orig,
    loadRuntimeExports: async () => ({}),
    buildApp: async (source: unknown) => {
      const hook = builds.during;
      builds.during = null;
      if (hook) await hook();
      const code = `/* ${createHash('sha256').update(JSON.stringify(source)).digest('hex')} */`;
      builds.done.push({ source, code });
      return { ok: true, code, errors: [], warnings: [], esbuildVersion: 'test' };
    },
  };
});
vi.mock('@mantle/storage/write', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/storage/write')>();
  return { ...orig, putContent: async () => undefined };
});

type Json = Record<string, unknown>;
type Reply = { isError?: boolean; content?: { text?: string }[] };
type Source = { entry: string; files: Record<string, string> };
type Login = 'owner' | 'admin' | 'moderator' | 'writer';
type ActorMode = 'off' | 'warn' | 'on';
type EditMode = 'off' | 'warn';
type Modes = { actor: ActorMode; edit: EditMode };

const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const PUBLISHED: Source = {
  entry: 'App.tsx',
  files: { 'App.tsx': 'export default function App() { return null; }\n' },
};

/** A draft unlike the published source: several files, about 40 KB. */
const draftOf = (tag: string): Source => ({
  entry: 'App.tsx',
  files: {
    'App.tsx': `import { help } from './lib/help';\nexport default function App() { return <pre>{help}</pre>; }\n// ${tag}\n${'// a line of the larger App.tsx\n'.repeat(600)}`,
    'lib/help.ts': `export const help = ${JSON.stringify('A plain help text line.\n'.repeat(800))};\n`,
    'lib/a.ts': `export const a = '${tag} a';\n`,
    'lib/b.ts': `export const b = '${tag} b';\n`,
  },
});

/** The modes this run covers: the full run every actor mode (in the order
 *  the box mode may only rise, as the process reads it once a minute),
 *  test:actor-off and test:actor-on their own; the edit check off and warn
 *  (dev runs warn). */
const MODES: Modes[] = (() => {
  const run = process.env.MANTLE_ACTOR_CHECK;
  const actors: ActorMode[] =
    run === 'off' ? ['off'] : run === 'on' ? ['on'] : ['off', 'warn', 'on'];
  const edits: EditMode[] = ['off', 'warn'];
  return actors.flatMap((actor) => edits.map((edit) => ({ actor, edit })));
})();

describe.skipIf(!URL)('app drafts under the row lock read as the caller’s scope reads them', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ls: typeof import('@mantle/mcp-core');
  let content: typeof import('@mantle/content');
  let web: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const tag = `ads${randomUUID().slice(0, 6)}`;
  const ids: Record<Login, string> = {
    owner: randomUUID(),
    admin: randomUUID(),
    moderator: randomUUID(),
    writer: randomUUID(),
  };
  const LOGINS = Object.keys(ids) as Login[];
  let adminWs = '';
  let teamWs = '';
  let projWs = '';
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  /** The box's checks, as an operator switches them, and this process's
   *  actor check (never below the box's). */
  const setModes = async (modes: Modes) => {
    process.env.MANTLE_ACTOR_CHECK = modes.actor;
    await su(sql`select mantle_set_actor_check(${modes.actor}, 50, 'test')`);
    await su(sql`select mantle_set_edit_check(${modes.edit}, 50, 'test')`);
  };

  /** The edit check's word on a Write-grant user's code change: the code
   *  needs a Moderator of the app's home (owner decision D4, 0280), so in
   *  warn each such write is noted, not refused. With the actor check off
   *  the write runs unscoped on the system pool and nothing is checked. The
   *  only note a test may leave, and only for the writer (vitest.setup.ts
   *  fails on any other). */
  const takeCodeNotes = (login: Login, modes: Modes) => {
    const all = m.takeActorMisses();
    const code = all.filter(
      (x) => x.source === 'sql' && /^edit: UPDATE on apps: no manage of the item/.test(x.check),
    );
    expect(all.filter((x) => !code.includes(x))).toEqual([]);
    if (login === 'writer' && modes.edit === 'warn' && modes.actor !== 'off') {
      expect(code.length).toBeGreaterThan(0);
    } else expect(code).toEqual([]);
  };

  /** An app the login may edit, published as PUBLISHED: the owner's in
   *  Admin; the Admin user's and the Moderator's homed in the project
   *  workspace they moderate; the writer's homed there too, with a Write
   *  grant to Team (the writer is a plain user of Team). */
  const appFor = async (login: Login): Promise<string> => {
    const ws = login === 'owner' ? adminWs : projWs;
    const app = await m.asSystem(
      () =>
        m.withCreateHome({ createWs: ws, privateWs: null, quiet: true }, () =>
          content.createApp(ids.owner, { title: `${tag} ${login} app`, source: PUBLISHED }),
        ),
      'test',
    );
    if (login === 'writer') {
      await m.asSystem(
        () =>
          m.withHeads([app.id], 'update', async (tx) => {
            await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                               values (${app.id}, ${teamWs}, true) on conflict do nothing`);
          }),
        'test',
      );
    }
    return app.id;
  };

  const row = async (id: string) =>
    (
      await x<{
        draft: Source | null;
        source: Source;
        build: string | null;
        published: string | null;
      }>(
        sql`select a.draft_source as draft, a.source, a.draft_build->>'sha256' as build,
                   a.published_build->>'sha256' as published
              from apps a where a.node_id = ${id}`,
      )
    )[0]!;

  /** An MCP client on the login's surface, as /api/mcp serves it. */
  const connect = async (login: Login) => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const prepared = await ls.prepareCallerTools({
      role: login === 'owner' || login === 'admin' ? 'admin' : 'member',
      anchorId: ids.owner,
      loginId: ids[login],
      via: 'oauth',
      write: true,
    });
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, prepared);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'app-draft-scope', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const call = async (name: string, args: Json) => {
      const r = (await c.callTool({ name, arguments: args })) as Reply;
      expect(r.isError ?? false, `${name}: ${text(r)}`).toBe(false);
      return r;
    };
    return { call, close: () => c.close() };
  };

  /** A request to the real web app with the login's session. */
  const request = async (
    p: string,
    login: Login,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Json }> => {
    const res = await web.request(p, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieOf(ids[login]) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const out = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(out) as Json;
    } catch {
      /* not json */
    }
    return { status: res.status, text: out, json };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'app-draft-scope-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'app-draft-scope-secret-at-least-32-characters!!';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the app draft test', { status: 503 })),
    );
    m = await import('@mantle/db');
    ls = await import('@mantle/mcp-core');
    content = await import('@mantle/content');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${ids.owner}, ${email('owner')}, 'x', true, 'admin', 'Owner'),
      (${ids.admin}, ${email('admin')}, 'x', false, 'admin', 'Second Admin'),
      (${ids.moderator}, ${email('mod')}, 'x', false, 'member', 'Moderator'),
      (${ids.writer}, ${email('writer')}, 'x', false, 'member', 'Writer')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${ids.owner}, 'brain', ${ids.owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const ws = await x<{ id: string; admin: boolean }>(sql`
      select id::text, is_admin as admin from workspaces
       where owner_id = ${ids.owner} and archived_at is null`);
    adminWs = ws.find((w) => w.admin)!.id;
    // A brain has no built-in Team: the writer's workspace is a normal one.
    const [proj, share] = await x<{ id: string }>(sql`
      insert into workspaces (owner_id, name) values
        (${ids.owner}, ${`${tag} Proj`}), (${ids.owner}, ${`${tag} Share`})
      returning id::text`);
    projWs = proj!.id;
    teamWs = share!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${projWs}, ${ids.admin}, true), (${projWs}, ${ids.moderator}, true),
      (${teamWs}, ${ids.writer}, false)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`);
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    web = await createApp();
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('every role a draft read runs as may run the scope rule', async () => {
    const [r] = await x<{ view: boolean; write: boolean }>(sql`
      select has_function_privilege('mantle_view_user',
               'public.mantle_may_edit_in(uuid[], uuid[], uuid, uuid[])', 'execute') as view,
             has_function_privilege('mantle_write_user',
               'public.mantle_may_edit_in(uuid[], uuid[], uuid, uuid[])', 'execute') as write`);
    expect(r).toEqual({ view: true, write: true });
  });

  describe.each(MODES)('actor check $actor, edit check $edit', (modes) => {
    it.each(LOGINS)(
      'MCP: %s writes a draft, keeps its files, builds it and publishes it',
      async (login) => {
        await setModes(modes);
        const id = await appFor(login);
        const draft = draftOf(`${tag} mcp ${login} ${modes.actor} ${modes.edit}`);
        expect(Buffer.byteLength(JSON.stringify(draft.files))).toBeGreaterThan(38_000);
        const c = await connect(login);
        try {
          await c.call('app_source_set', { id, ...draft });
          expect((await row(id)).draft).toEqual(draft);
          const extra = `export const c = '${tag}';\n`;
          await c.call('app_file_write', { id, path: 'lib/c.ts', content: extra });
          const written = (await row(id)).draft;
          expect(written).toEqual({ ...draft, files: { ...draft.files, 'lib/c.ts': extra } });
          builds.done.length = 0;
          await c.call('app_build', { id });
          // One build, of the draft, recorded.
          expect(builds.done).toHaveLength(1);
          expect(builds.done[0]!.source).toEqual(written);
          expect((await row(id)).build).toBe(sha(builds.done[0]!.code));
          await c.call('app_update', { id, name: `${tag} renamed`, description: 'renamed' });
          expect((await row(id)).draft).toEqual(written);
          await c.call('app_publish', { id });
          const live = await row(id);
          expect(live.source).toEqual(written);
          expect(live.published).toBe(sha(builds.done[0]!.code));
          expect(live.draft).toBeNull();
          takeCodeNotes(login, modes);
        } finally {
          await c.close();
        }
      },
      60_000,
    );

    it.each(LOGINS)(
      'MCP: %s builds again when the source changed during the build, and records only that',
      async (login) => {
        await setModes(modes);
        const id = await appFor(login);
        const draft = draftOf(`${tag} race ${login} ${modes.actor} ${modes.edit}`);
        const c = await connect(login);
        try {
          await c.call('app_source_set', { id, ...draft });
          builds.done.length = 0;
          // Another writer's edit lands while the first build runs (made
          // here, outside the call's scope, while the build waits).
          let started = () => {};
          let finish = () => {};
          const inBuild = new Promise<void>((ok) => (started = ok));
          const edited = new Promise<void>((ok) => (finish = ok));
          builds.during = async () => {
            started();
            await edited;
          };
          const building = c.call('app_build', { id });
          await inBuild;
          await m.asSystem(
            () => content.writeDraftFile(ids.owner, id, 'lib/d.ts', 'export const d = 1;\n'),
            'test',
          );
          finish();
          await building;
          expect(builds.done).toHaveLength(2);
          const now = await row(id);
          expect(now.draft?.files['lib/d.ts']).toBe('export const d = 1;\n');
          expect(builds.done[0]!.source).toEqual(draft);
          expect(builds.done[1]!.source).toEqual(now.draft);
          expect(now.build).toBe(sha(builds.done[1]!.code));
          takeCodeNotes(login, modes);
        } finally {
          builds.during = null;
          await c.close();
        }
      },
      60_000,
    );

    it.each(LOGINS)(
      'web: %s saves over the stamp it read, builds the draft and commits it',
      async (login) => {
        await setModes(modes);
        const id = await appFor(login);
        const draft = draftOf(`${tag} web ${login} ${modes.actor} ${modes.edit}`);
        const first = await request(`/api/apps/${id}/draft`, login, 'PUT', {
          ...draft,
          baseDraftUpdatedAt: null,
        });
        expect(first.status, first.text.slice(0, 300)).toBe(200);
        const read = await request(`/api/apps/${id}`, login, 'GET');
        expect(read.status, read.text.slice(0, 300)).toBe(200);
        const app = read.json.app as { draft: Source | null; draftUpdatedAt: string | null };
        expect(app.draft).toEqual(draft);
        expect(app.draftUpdatedAt).toBe(first.json.draftUpdatedAt);
        const next: Source = {
          ...draft,
          files: { ...draft.files, 'lib/a.ts': 'export const a = 2;\n' },
        };
        const saved = await request(`/api/apps/${id}/draft`, login, 'PUT', {
          ...next,
          baseDraftUpdatedAt: app.draftUpdatedAt,
        });
        expect(saved.status, saved.text.slice(0, 300)).toBe(200);
        // A save over a stamp that is no longer the draft's is refused.
        const late = await request(`/api/apps/${id}/draft`, login, 'PUT', {
          ...draft,
          baseDraftUpdatedAt: app.draftUpdatedAt,
        });
        expect(late.status, late.text.slice(0, 300)).toBe(409);
        expect((await row(id)).draft).toEqual(next);
        builds.done.length = 0;
        const built = await request(`/api/apps/${id}/build`, login, 'POST', {});
        expect(built.status, built.text.slice(0, 300)).toBe(200);
        expect(built.json.buildOk, built.text.slice(0, 300)).toBe(true);
        expect(builds.done).toHaveLength(1);
        expect(builds.done[0]!.source).toEqual(next);
        const committed = await request(`/api/apps/${id}/publish`, login, 'POST', {});
        expect(committed.status, committed.text.slice(0, 300)).toBe(200);
        const live = await row(id);
        expect(live.source).toEqual(next);
        expect(live.draft).toBeNull();
        takeCodeNotes(login, modes);
      },
      60_000,
    );

    it.each(LOGINS)(
      'the stale check still refuses a build of source that changed meanwhile (%s, MCP scope)',
      async (login) => {
        await setModes(modes);
        const id = await appFor(login);
        const draft = draftOf(`${tag} stale ${login} ${modes.actor} ${modes.edit}`);
        const c = await connect(login);
        try {
          await c.call('app_source_set', { id, ...draft });
        } finally {
          await c.close();
        }
        const scope = await m.loginScopeFor(ids[login]);
        const ref = {
          storageKey: 'test',
          sha256: 'test',
          builtAt: new Date().toISOString(),
          esbuildVersion: 'test',
          bytes: 1,
          ok: true,
        };
        const asLogin = <T>(fn: () => Promise<T>) =>
          m.runAsActor(m.loginActor(ids[login], 'rw'), () =>
            m.withTurnScope(scope, fn, { writes: true }),
          );
        await asLogin(() =>
          content.writeDraftFile(ids.owner, id, 'lib/d.ts', 'export const d = 1;\n'),
        );
        expect(
          await asLogin(() => content.setDraftBuild(ids.owner, id, ref, { builtFrom: draft })),
        ).toBe('stale');
        expect((await row(id)).build).toBeNull();
        const now = (await row(id)).draft!;
        expect(Object.keys(now.files).sort()).toEqual(
          [...Object.keys(draft.files), 'lib/d.ts'].sort(),
        );
        expect(
          await asLogin(() => content.setDraftBuild(ids.owner, id, ref, { builtFrom: now })),
        ).toBe(true);
        expect((await row(id)).build).toBe('test');
        takeCodeNotes(login, modes);
      },
      60_000,
    );
  });
});
