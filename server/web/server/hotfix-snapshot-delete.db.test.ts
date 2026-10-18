/**
 * Hotfix: app_snapshot_delete asks the caller's edit of the app again
 * (docs/_archive/hotfix-snapshot-delete.md; the S11a tool matrix's S11a-2).
 *
 * R0 (v0.300.83) removed the tool's item pre-check (`items: [edit('id')]`)
 * because the database's checks cover it. They do only while the EDIT check
 * is on: node_snapshots has no write check (the actor check's 0278 rows),
 * only the edit check's trigger (mantle_edit_check_edit, delete: 'edit' of
 * node_id), which warn lets through and off never fires. So with the edit
 * check below on, any login that reads an app deleted its snapshots.
 * deleteAppSnapshot now asks the one item-rights gateway first
 * (assertItemRight(appId, 'edit')), whatever the box's modes.
 *
 * Each cell takes a fresh snapshot of a fresh app placed for the caller,
 * calls the tool on the login's own MCP surface or in an assistant turn, and
 * checks the outcome, that a refused call leaves the app's history as it
 * was, and the answer's words: those of v0.300.82 (c7acc88ff, the
 * pre-check), recorded with HFSD_RECORD=1 on that code (ids as ID).
 *
 * Callers: the owner and a second Admin user (an app in Admin: allowed; the
 * owner on an app homed elsewhere granted to Admin read only: refused), and
 * a member: an outsider (reads nothing of it), a read grant, a read grant
 * whose Write is on a sibling app (both refused), a Write grant and a
 * Moderator of the app's home (both allowed, as with the pre-check). The
 * member's own snapshot (app_snapshot_create, then delete) still goes.
 * Check modes: actor on with the edit check off and on, actor warn with the
 * edit check warn and off.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/hotfix-snapshot-delete.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
/** Record the answers (print them, check nothing): run on v0.300.82. */
const RECORD = process.env.HFSD_RECORD === '1';

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Who = 'owner' | 'admin' | 'member';
type Way = 'mcp' | 'turn';
type Place =
  | 'adminHome'
  | 'adminReadOnly'
  | 'outsider'
  | 'readGrant'
  | 'siblingWrite'
  | 'writeGrant'
  | 'homeModerator';
type Modes = { actor: 'on' | 'warn'; edit: 'on' | 'warn' | 'off' };
type Reply = { isError?: boolean; content?: { text?: string }[] };
type Outcome = { ok: boolean; text: string };

const MODES: readonly Modes[] = [
  { actor: 'on', edit: 'off' },
  { actor: 'on', edit: 'on' },
  { actor: 'warn', edit: 'warn' },
  { actor: 'warn', edit: 'off' },
];

/** The cells: who, where the app is, whether the delete goes. */
const CELLS: readonly { who: Who; place: Place; allowed: boolean }[] = [
  { who: 'owner', place: 'adminHome', allowed: true },
  { who: 'owner', place: 'adminReadOnly', allowed: false },
  { who: 'admin', place: 'adminHome', allowed: true },
  { who: 'member', place: 'outsider', allowed: false },
  { who: 'member', place: 'readGrant', allowed: false },
  { who: 'member', place: 'siblingWrite', allowed: false },
  { who: 'member', place: 'writeGrant', allowed: true },
  { who: 'member', place: 'homeModerator', allowed: true },
];

/**
 * v0.300.82's answer to each refused cell (c7acc88ff, the tool's pre-check
 * `items: [edit('id')]`), recorded with HFSD_RECORD=1, ids as ID: the same
 * in every check mode, the MCP surface's with its "Error: " before it. An
 * app the caller does not read is the precondition's "not found", as then.
 */
const NO_EDIT_82 =
  'You cannot change this item in your workspaces (ID): ask for Write on it, or a Moderator of its workspace.';
const MAIN_82: Readonly<Record<string, string>> = {
  'owner adminReadOnly': NO_EDIT_82,
  'member outsider':
    'app ID not found — it may have been deleted or the id mistyped. Find the right id with app_list, then re-issue.',
  'member readGrant': NO_EDIT_82,
  'member siblingWrite': NO_EDIT_82,
};
const main82 = (name: string, way: Way) => `${way === 'mcp' ? 'Error: ' : ''}${MAIN_82[name]}`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const plain = (text: string) => text.replace(UUID, 'ID');

describe.skipIf(!DB_URL)('hotfix: app_snapshot_delete asks the edit of the app', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let rt: typeof import('@mantle/runtime/agent');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let dir = '';
  const tag = `hfsd${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const adm = randomUUID();
  const mem = randomUUID();
  const ws = { admin: '', H: '', R: '', W: '', X: '', O: '' };
  const agentOf: Record<string, string> = {};
  const recorded: string[] = [];
  let sibling = '';

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:hfsd', fn) as Promise<T>;
  const sysTool = async (slug: string, input: Record<string, unknown>): Promise<unknown> => {
    const row = { slug, handler: { kind: 'builtin', ref: slug } } as never;
    const res = await sys(() =>
      t.dispatchTool(row, input, {
        ownerId: owner,
        surface: { kind: 'owner', via: 'api' },
        caller: t.apiV1Caller(),
      }),
    );
    if (!res.ok) throw new Error(`fixture ${slug}: ${String(res.error)}`);
    return res.output;
  };
  const idIn = (out: unknown): string => {
    const m0 = new RegExp(UUID.source).exec(JSON.stringify(out));
    if (!m0) throw new Error(`no id in ${JSON.stringify(out).slice(0, 200)}`);
    return m0[0];
  };

  const grantsOf = (p: Place): [string, boolean, boolean][] => {
    switch (p) {
      case 'adminHome':
        return [[ws.admin, true, false]];
      case 'adminReadOnly':
        return [
          [ws.X, true, false],
          [ws.admin, false, false],
        ];
      case 'outsider':
        return [[ws.O, true, false]];
      case 'readGrant':
      case 'siblingWrite':
        return [
          [ws.X, true, false],
          [ws.W, false, false],
        ];
      case 'writeGrant':
        return [
          [ws.X, true, false],
          [ws.W, false, true],
        ];
      case 'homeModerator':
        return [[ws.H, true, false]];
    }
  };
  const grant = async (id: string, grants: [string, boolean, boolean][]) => {
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      for (const [w, home, write] of grants) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${w}, ${home}, ${write})`;
      }
    });
  };

  /** A fresh app with one snapshot, placed. */
  const appWithSnapshot = async (p: Place) => {
    const id = idIn(
      await sysTool('app_create', { name: `${tag} app ${randomUUID().slice(0, 8)}` }),
    );
    const out = (await sysTool('app_snapshot_create', { id, note: 'kept' })) as {
      snapshot: { id: string };
    };
    await grant(id, grantsOf(p));
    return { id, sid: out.snapshot.id };
  };
  /** The app's history, as rows (a refused call leaves it as it was). */
  const history = async (id: string) =>
    (
      await raw<
        { h: string | null }[]
      >`select string_agg(row_to_json(x)::text, ',' order by x.id) as h
        from node_snapshots x where x.node_id = ${id}`
    )[0]!.h ?? '';
  const snapshotLeft = async (sid: string) =>
    (
      await raw<{ c: number }[]>`select count(*)::int as c from node_snapshots where id = ${sid}`
    )[0]!.c;

  const loginOf = (who: Who) => (who === 'owner' ? owner : who === 'admin' ? adm : mem);
  const actorOf = (who: Who) =>
    who === 'owner'
      ? m.loginActor(owner, 'owner')
      : who === 'admin'
        ? m.loginActor(adm, 'rw')
        : m.loginActor(mem, 'rw');

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
    } catch (err) {
      return { ok: false, text: `THROWN ${(err as Error).message}` };
    } finally {
      await c.close();
    }
  };

  /** The workspace whose assistant runs the turn: one that reads the app
   *  where the login does (the outsider's: one that reads nothing of it). */
  const turnWs = (who: Who, p: Place) =>
    who !== 'member' ? ws.admin : p === 'homeModerator' ? ws.H : p === 'outsider' ? ws.R : ws.W;

  const viaTurn = async (
    who: Who,
    p: Place,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> => {
    const wsId = turnWs(who, p);
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
  const call = (way: Way, who: Who, p: Place, slug: string, input: Record<string, unknown>) =>
    way === 'mcp' ? viaMcp(who, slug, input) : viaTurn(who, p, slug, input);

  /** Set both checks' box modes (and this process's actor mode). */
  const setModes = async (mo: Modes) => {
    for (const [fn, mode] of [
      ['mantle_set_actor_check', mo.actor],
      ['mantle_set_edit_check', mo.edit],
    ] as const) {
      // v0.300.83 (0301) takes a reason to lower a check; v0.300.82 has none.
      try {
        await raw.unsafe(`select ${fn}($1, 50, 'hotfix test')`, [mode]);
      } catch {
        await raw.unsafe(`select ${fn}($1, 50)`, [mode]);
      }
    }
    process.env.MANTLE_ACTOR_CHECK = mo.actor;
    actorMode.noteBoxActorCheckMode(mo.actor);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'hotfix-snapshot-delete-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'hotfix-snapshot-delete-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the hotfix test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    rt = await import('@mantle/runtime/agent');
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
    for (const key of ['H', 'R', 'W', 'X', 'O'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    await raw`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and not w.is_admin
                 and u.login_id in (${owner}, ${adm}, ${mem})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.H}, ${mem}, true), (${ws.R}, ${mem}, false), (${ws.W}, ${mem}, false)`;
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
    // The sibling: an app the member may change (Write on for W), beside
    // the one it only reads.
    sibling = (await appWithSnapshot('writeGrant')).id;
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['app_snapshot_delete, each cell:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mo of MODES) {
    it(`actor ${mo.actor}, edit ${mo.edit}: each caller as v0.300.82 answered`, async () => {
      await setModes(mo);
      const bad: string[] = [];
      for (const cell of CELLS) {
        for (const way of ['mcp', 'turn'] as const) {
          const { id, sid } = await appWithSnapshot(cell.place);
          const before = await history(id);
          const out = await call(way, cell.who, cell.place, 'app_snapshot_delete', {
            id,
            snapshot_id: sid,
          });
          const after = await history(id);
          const left = await snapshotLeft(sid);
          const name = `${cell.who} ${cell.place}`;
          recorded.push(
            `[actor ${mo.actor} edit ${mo.edit}] ${name} ${way}: ${out.ok ? 'ok' : 'refused'}` +
              `${after !== before ? ' changed' : ''}: ${plain(out.text).slice(0, 220)}`,
          );
          if (RECORD) continue;
          if (cell.allowed) {
            if (!out.ok || left !== 0) bad.push(`${name} ${way}: not deleted: ${out.text}`);
          } else {
            if (out.ok) bad.push(`${name} ${way}: deleted`);
            if (after !== before || left !== 1) bad.push(`${name} ${way}: the history changed`);
            if (plain(out.text) !== main82(name, way)) {
              bad.push(`${name} ${way}: "${plain(out.text)}" is not main .82's`);
            }
          }
        }
      }
      expect(bad).toEqual([]);
    }, 300_000);
  }

  it('the member deletes a snapshot it took (N6), in every mode', async () => {
    for (const mo of MODES) {
      await setModes(mo);
      for (const way of ['mcp', 'turn'] as const) {
        const { id } = await appWithSnapshot('writeGrant');
        const made = await call(way, 'member', 'writeGrant', 'app_snapshot_create', {
          id,
          note: 'mine',
        });
        expect(made.ok, made.text).toBe(true);
        const sid = idIn(
          (
            await raw<{ id: string }[]>`select id::text as id from node_snapshots
              where node_id = ${id} and note = 'mine'`
          ).map((r) => r.id),
        );
        const out = await call(way, 'member', 'writeGrant', 'app_snapshot_delete', {
          id,
          snapshot_id: sid,
        });
        recorded.push(`[N6 actor ${mo.actor} edit ${mo.edit}] ${way}: ${plain(out.text)}`);
        if (RECORD) continue;
        expect(out.ok, out.text).toBe(true);
        expect(await snapshotLeft(sid)).toBe(0);
      }
    }
  }, 300_000);

  it('the sibling the member may change is untouched by the refused calls', async () => {
    expect(await history(sibling)).not.toBe('');
  });
});
