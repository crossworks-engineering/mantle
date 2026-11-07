/**
 * A member's agent gets no more than the member's rights (owner, 2026-11-07):
 *
 *  - A member without Write is refused a data restore, a seed and a schema
 *    change, whichever way it comes.
 *  - A delete and an undelete keep MCP access, and a copy opens none.
 *  - A table's rollback points are a Moderator's to remove
 *    (hotfix-snapshot-delete.db.test.ts holds the same for an app).
 *
 * Every call goes through the login's own MCP surface or an assistant turn, in
 * each check mode.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/app-data-rights.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Who = 'owner' | 'admin' | 'member';
type Place = 'adminHome' | 'readGrant' | 'writeGrant' | 'homeModerator';
type Reply = { isError?: boolean; content?: { text?: string }[] };
type Outcome = { ok: boolean; text: string };
type Modes = { actor: 'on' | 'warn'; edit: 'on' | 'warn' | 'off' };

const MODES: readonly Modes[] = [
  { actor: 'on', edit: 'on' },
  { actor: 'warn', edit: 'off' },
];
const SCHEMA = {
  schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
  schemaVersion: 1,
};
const REFUSED = 'You cannot change this item in your workspaces.';

describe.skipIf(!DB_URL)("an agent's writes follow its person's rights", () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let rt: typeof import('@mantle/runtime/agent');
  let apps: typeof import('../../../packages/content/src/apps');
  let broker: typeof import('../../../packages/content/src/app-broker');
  let snaps: typeof import('../../../packages/content/src/app-snapshots');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let dir = '';
  const tag = `adr${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const adm = randomUUID();
  const mem = randomUUID();
  const ws = { admin: '', H: '', W: '', X: '' };
  const agentOf: Record<string, string> = {};

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:adr', fn) as Promise<T>;

  const grantsOf = (p: Place): [string, boolean, boolean][] => {
    if (p === 'adminHome') return [[ws.admin, true, false]];
    if (p === 'homeModerator') return [[ws.H, true, false]];
    if (p === 'readGrant') {
      return [
        [ws.X, true, false],
        [ws.W, false, false],
      ];
    }
    return [
      [ws.X, true, false],
      [ws.W, false, true],
    ];
  };
  const inTx = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await fn(tx);
    });
  const place = (id: string, p: Place) =>
    inTx(async (tx) => {
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      for (const [w, home, write] of grantsOf(p)) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${w}, ${home}, ${write})`;
      }
    });

  /** A published app with one row, a snapshot of it, then a second row. */
  const appWithData = async (p: Place) => {
    const id = await sys(async () => {
      const app = await apps.createApp(owner, { title: `${tag} ${randomUUID().slice(0, 8)}` });
      await apps.writeDraftFile(owner, app.id, 'App.tsx', 'export default () => "one";');
      await apps.setManifest(owner, app.id, { sqlite: SCHEMA });
      await apps.setDraftBuild(owner, app.id, {
        storageKey: 'attachments/aa/bb/test',
        sha256: 'test',
        builtAt: '2026-10-02T00:00:00.000Z',
        esbuildVersion: 'test',
        bytes: 1,
        ok: true,
        rules: m.APP_BUILD_RULES,
      });
      await apps.publishApp(owner, app.id, { note: 'first', actor: 'owner' });
      return app.id;
    });
    const exec = (name: string) =>
      sys(() =>
        broker.appDbExec(owner, id, `INSERT INTO items (name) VALUES ('${name}')`, [], SCHEMA),
      );
    await exec('a');
    const snap = await sys(() => snaps.createAppSnapshot(owner, id, { note: 'point' }));
    await exec('b');
    await place(id, p);
    return { id, sid: snap!.id };
  };
  const rowCount = async (id: string) => {
    const res = await sys(() =>
      broker.appDbQuery(owner, id, 'SELECT count(*) AS c FROM items', [], SCHEMA),
    );
    return Number(res[0]!.c);
  };

  const loginOf = (who: Who) => (who === 'owner' ? owner : who === 'admin' ? adm : mem);
  const actorOf = (who: Who) =>
    who === 'owner' ? m.loginActor(owner, 'owner') : m.loginActor(loginOf(who), 'rw');

  const viaMcp = async (
    who: Who,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: tag, version: '0' });
    const caller = {
      role: who === 'member' ? 'member' : 'admin',
      anchorId: owner,
      loginId: loginOf(who),
      via: 'oauth',
      write: true,
      oauthClientId: tag,
    };
    ls.registerPreparedTools(server, await ls.prepareCallerTools(caller as never));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: tag, version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    try {
      const r = (await m.runAsActor(actorOf(who), () =>
        c.callTool({ name: slug, arguments: input }),
      )) as Reply;
      return {
        ok: !(r.isError ?? false),
        text: (r.content ?? []).map((x) => x.text ?? '').join(' '),
      };
    } finally {
      await c.close();
    }
  };

  /** An assistant turn of `who`, in the workspace `wsId`, as the hotfix's. */
  const viaTurn = async (
    who: Who,
    wsId: string,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> => {
    const row =
      (await sys(() => t.resolveTool(owner, slug))) ??
      ({ slug, handler: { kind: 'builtin', ref: slug } } as never);
    const login = loginOf(who);
    try {
      const res = await m.runAsActor(actorOf(who), () =>
        rt.withAgentScope(
          { id: agentOf[wsId]!, ownerId: owner, workspaceId: wsId },
          () =>
            t.dispatchTool(row, input, {
              ownerId: owner,
              surface: { kind: 'web', loginId: login } as never,
              caller: t.turnCaller(),
            }),
          { loginId: login },
        ),
      );
      return { ok: res.ok, text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error) };
    } catch (err) {
      return { ok: false, text: `THROWN ${(err as Error).message}` };
    }
  };

  /** The app's declared schema and its data's schema version, as stored. */
  const schemaOf = async (id: string) => {
    const [row] = await raw<{ manifest: string | null; db: number | null }[]>`
      select a.manifest->'sqlite'->>'schemaVersion' as manifest,
             (select d.schema_version from app_databases d where d.app_node_id = a.node_id) as db
        from apps a where a.node_id = ${id}`;
    return { manifest: Number(row?.manifest ?? 0), db: Number(row?.db ?? 0) };
  };
  const switchesOf = async (id: string) => {
    const [row] = await raw<{ mcp: boolean }[]>`
      select mcp_access as mcp from apps where node_id = ${id}`;
    return row;
  };
  const snapshotsOf = async (id: string, trigger: string) =>
    (
      await raw<{ c: number }[]>`select count(*)::int as c from node_snapshots
        where node_id = ${id} and trigger = ${trigger}`
    )[0]!.c;

  const setModes = async (mo: Modes) => {
    for (const [fn, mode] of [
      ['mantle_set_actor_check', mo.actor],
      ['mantle_set_edit_check', mo.edit],
    ] as const) {
      await raw.unsafe(`select ${fn}($1, 50, 'app data rights test')`, [mode]);
    }
    process.env.MANTLE_ACTOR_CHECK = mo.actor;
    actorMode.noteBoxActorCheckMode(mo.actor);
  };

  const restore = (who: Who, id: string, sid: string, mode: 'code' | 'data' | 'full') =>
    viaMcp(who, 'app_snapshot_restore', { id, snapshot_id: sid, mode, discard_draft: true });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'app-data-rights-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'app-data-rights-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in this test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    rt = await import('@mantle/runtime/agent');
    apps = await import('../../../packages/content/src/apps');
    broker = await import('../../../packages/content/src/app-broker');
    snaps = await import('../../../packages/content/src/app-snapshots');
    actorMode = await import('../../../packages/db/src/actor');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${adm}, ${`${tag}-admin@example.invalid`}, 'x', false, 'admin', 'Admin'),
             (${mem}, ${`${tag}-member@example.invalid`}, 'x', false, 'member', 'Member')`;
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                  where owner_id = ${owner} and is_admin`
    )[0]!.id;
    for (const key of ['H', 'W', 'X'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    await raw`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and not w.is_admin
                 and u.login_id in (${owner}, ${adm}, ${mem})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.H}, ${mem}, true), (${ws.W}, ${mem}, false)`;
    // The second Admin user sits in the Admin workspace, as an Admin user does.
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.admin}, ${adm}, false) on conflict do nothing`;
    for (const [key, wsId] of Object.entries(ws)) {
      const id = randomUUID();
      agentOf[wsId] = id;
      await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${id}, ${owner}, ${`${tag}-${key}`}, ${key}, 'fake/model', 'p',
                ${key === 'admin' ? 'assistant' : 'responder'}, ${wsId})`;
    }
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mo of MODES) {
    const label = `actor ${mo.actor}, edit ${mo.edit}`;

    it(`${label}: a member without Write is refused a data restore, a seed and a schema change`, async () => {
      await setModes(mo);
      for (const mode of ['data', 'full'] as const) {
        const { id, sid } = await appWithData('readGrant');
        const out = await restore('member', id, sid, mode);
        expect(out.ok, `${mode}: ${out.text}`).toBe(false);
        expect(out.text).toContain(REFUSED);
        expect(await rowCount(id)).toBe(2);
      }
      const seeded = await appWithData('readGrant');
      const seed = await viaMcp('member', 'app_db_seed', {
        id: seeded.id,
        table: 'items',
        rows: [{ name: 'c' }],
      });
      expect(seed.ok, seed.text).toBe(false);
      expect(seed.text).toContain(REFUSED);
      expect(await rowCount(seeded.id)).toBe(2);
      const schema = await appWithData('readGrant');
      const before = await schemaOf(schema.id);
      const snapshots = await snapshotsOf(schema.id, 'pre_schema');
      const script = `${SCHEMA.schemaSql} DELETE FROM items;`;
      for (const way of ['mcp', 'turn'] as const) {
        const input = { id: schema.id, schema_sql: script };
        const out =
          way === 'mcp'
            ? await viaMcp('member', 'app_db_schema_set', input)
            : await viaTurn('member', ws.W, 'app_db_schema_set', input);
        expect(out.ok, `${way}: ${out.text}`).toBe(false);
        expect(out.text).toContain(REFUSED);
        expect(await schemaOf(schema.id)).toEqual(before);
        expect(await snapshotsOf(schema.id, 'pre_schema')).toBe(snapshots);
        expect(await rowCount(schema.id)).toBe(2);
      }
    }, 300_000);

    it(`${label}: an assistant turn holds to the same rule`, async () => {
      await setModes(mo);
      const shut = await appWithData('readGrant');
      const seed = await viaTurn('member', ws.W, 'app_db_seed', {
        id: shut.id,
        table: 'items',
        rows: [{ name: 'c' }],
      });
      expect(seed.ok, seed.text).toBe(false);
      expect(await rowCount(shut.id)).toBe(2);
      const data = await viaTurn('member', ws.W, 'app_snapshot_restore', {
        id: shut.id,
        snapshot_id: shut.sid,
        mode: 'data',
        discard_draft: true,
      });
      expect(data.ok, data.text).toBe(false);
      expect(data.text).toContain(REFUSED);
      expect(await rowCount(shut.id)).toBe(2);
    }, 300_000);

    it(`${label}: a delete and an undelete keep MCP access`, async () => {
      await setModes(mo);
      const { id } = await appWithData('homeModerator');
      await inTx((tx) => tx`update apps set mcp_access = true where node_id = ${id}`);
      const gone = await viaMcp('member', 'app_delete', { id });
      expect(gone.ok, gone.text).toBe(true);
      const back = await viaMcp('member', 'app_undelete', { id });
      expect(back.ok, back.text).toBe(true);
      expect(await switchesOf(id)).toEqual({ mcp: true });
      expect(await rowCount(id)).toBe(2);
      // An app with it off comes back off.
      const open = await appWithData('homeModerator');
      expect((await viaMcp('member', 'app_delete', { id: open.id })).ok).toBe(true);
      expect((await viaMcp('member', 'app_undelete', { id: open.id })).ok).toBe(true);
      expect(await switchesOf(open.id)).toEqual({ mcp: false });
    }, 300_000);

    it(`${label}: a copy opens no MCP access`, async () => {
      await setModes(mo);
      const copyOf = async (who: Who, id: string, name: string) => {
        // A member's copy of the code alone: it asks a read of the source.
        const data = who === 'member' ? { with_data: false } : {};
        const out = await viaMcp(who, 'app_duplicate', { id, name, ...data });
        const [made] = await raw<{ id: string }[]>`
          select id::text as id from nodes where type = 'app' and title = ${name}`;
        return { out, made: made?.id ?? null };
      };
      for (const who of ['owner', 'admin'] as const) {
        const { id } = await appWithData('adminHome');
        await inTx((tx) => tx`update apps set mcp_access = true where node_id = ${id}`);
        const kept = await copyOf(who, id, `${tag} kept ${randomUUID().slice(0, 8)}`);
        expect(kept.out.ok, `${who}: ${kept.out.text}`).toBe(true);
        expect(await switchesOf(kept.made!)).toEqual({ mcp: false });
      }
      const free = await appWithData('homeModerator');
      const copied = await copyOf('member', free.id, `${tag} free ${randomUUID().slice(0, 8)}`);
      expect(copied.out.ok, copied.out.text).toBe(true);
      expect(await switchesOf(copied.made!)).toEqual({ mcp: false });
    }, 300_000);

    it(`${label}: a row from before MCP access was kept comes back off`, async () => {
      await setModes(mo);
      const { id } = await appWithData('homeModerator');
      await inTx((tx) => tx`update apps set mcp_access = true where node_id = ${id}`);
      expect((await viaMcp('member', 'app_delete', { id })).ok).toBe(true);
      await inTx(
        (tx) => tx`update node_snapshots
          set code = code #- '{meta,mcpAccess}'
          where node_id = ${id} and trigger = 'pre_delete'`,
      );
      const back = await viaMcp('member', 'app_undelete', { id });
      expect(back.ok, back.text).toBe(true);
      expect(await switchesOf(id)).toEqual({ mcp: false });
      expect(await rowCount(id)).toBe(2);
    }, 300_000);

    it(`${label}: a member with Write restores and seeds`, async () => {
      await setModes(mo);
      for (const [p, mode] of [
        ['writeGrant', 'data'],
        ['homeModerator', 'data'],
        ['homeModerator', 'full'],
      ] as const) {
        const { id, sid } = await appWithData(p);
        const out = await restore('member', id, sid, mode);
        expect(out.ok, `${p} ${mode}: ${out.text}`).toBe(true);
        expect(await rowCount(id)).toBe(1);
      }
      for (const p of ['writeGrant', 'homeModerator'] as const) {
        const seeded = await appWithData(p);
        const out = await viaMcp('member', 'app_db_seed', {
          id: seeded.id,
          table: 'items',
          rows: [{ name: 'c' }],
        });
        expect(out.ok, `${p}: ${out.text}`).toBe(true);
        expect(await rowCount(seeded.id)).toBe(3);
      }
      // A Moderator's own schema script, the app's code.
      const coded = await appWithData('homeModerator');
      const before = await schemaOf(coded.id);
      const out = await viaMcp('member', 'app_db_schema_set', {
        id: coded.id,
        schema_sql: SCHEMA.schemaSql,
      });
      expect(out.ok, out.text).toBe(true);
      expect((await schemaOf(coded.id)).manifest).toBeGreaterThan(before.manifest);
    }, 300_000);

    it(`${label}: a table's rollback point is a Moderator's to remove`, async () => {
      await setModes(mo);
      const tableWithPoint = async (p: Place) => {
        const row = { slug: 'x', handler: { kind: 'builtin', ref: 'x' } };
        const run = async (slug: string, input: Record<string, unknown>) => {
          const res = await sys(() =>
            t.dispatchTool(
              { ...row, slug, handler: { kind: 'builtin', ref: slug } } as never,
              input,
              {
                ownerId: owner,
                surface: { kind: 'owner', via: 'api' },
                caller: t.apiV1Caller(),
              },
            ),
          );
          if (!res.ok) throw new Error(`fixture ${slug}: ${String(res.error)}`);
          return res.output as Record<string, unknown>;
        };
        const made = await run('table_create', { title: `${tag} ${randomUUID().slice(0, 8)}` });
        const id = String(made.id);
        const point = await run('table_snapshot_create', { id, note: 'point' });
        await place(id, p);
        return { id, sid: String((point.snapshot as { id: string }).id) };
      };
      const left = async (sid: string) =>
        (
          await raw<
            { c: number }[]
          >`select count(*)::int as c from node_snapshots where id = ${sid}`
        )[0]!.c;

      const shut = await tableWithPoint('writeGrant');
      const refused = await viaMcp('member', 'table_snapshot_delete', {
        id: shut.id,
        snapshot_id: shut.sid,
      });
      expect(refused.ok, refused.text).toBe(false);
      expect(refused.text).toContain(REFUSED);
      expect(await left(shut.sid)).toBe(1);

      const open = await tableWithPoint('homeModerator');
      const allowed = await viaMcp('member', 'table_snapshot_delete', {
        id: open.id,
        snapshot_id: open.sid,
      });
      expect(allowed.ok, allowed.text).toBe(true);
      expect(await left(open.sid)).toBe(0);
    }, 300_000);
  }
});
