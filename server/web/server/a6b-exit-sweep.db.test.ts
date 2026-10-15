/**
 * The A6b exit sweep (workspaces arch plan v2, A6b: the system-pool exits
 * toward 40). Each group of exits that moves into the scope, or behind a
 * narrow definer, is recorded here on main BEFORE it moves, and compared
 * after: every answer must match, or be a named change with its reason. A
 * looser answer is a blocker.
 *
 * The logins: the brain's owner (the anchor, an Admin user), an Admin user
 * with every area, an Admin user without the users area, a member who
 * moderates P and is a plain user of Q, a plain user of Q, a member in no
 * workspace (the outsider). Workspaces: Admin, P, Q. Each group asks its
 * libraries in every context they run in (the system pool; a login's read
 * and write request scope as the session guard enters them; an assistant's
 * turn in Admin, P and Q with and without a login), and its routes through
 * the real app (createApp) with each login's session cookie.
 *
 * One record per section and check mode (MANTLE_ACTOR_CHECK: off, warn, on;
 * the suite runs this file in all three): __snapshots__/a6b-exit-sweep.
 * <section>.<mode>.txt. Recorded on main with A6B_RECORD=<section,...|all>;
 * a normal run only compares.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a6b-exit-sweep.db.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MODE = (process.env.MANTLE_ACTOR_CHECK ?? 'warn').trim() || 'warn';
const RECORD = new Set(
  (process.env.A6B_RECORD ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const HERE = dirname(fileURLToPath(import.meta.url));
const snapOf = (section: string) =>
  join(HERE, '__snapshots__', `a6b-exit-sweep.${section}.${MODE}.txt`);

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => undefined,
  requestMetaFrom: () => ({}),
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));

// The object store is outside this box's test.
vi.mock('@mantle/storage/write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/storage/write')>()),
  putContent: async (body: Buffer) => {
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(body).digest('hex');
    return { key: `test/${sha256}`, sha256, size: body.length, deduped: false };
  },
}));

/**
 * Cells whose answer changed on purpose, per section: the cells a pattern
 * names, its reason, and `back`, which turns the new answer into main's
 * form; the cell must then read exactly as main recorded it.
 */
const NAMED_CHANGES: Record<
  string,
  ReadonlyArray<{ cells: RegExp; reason: string; back: (now: string) => string }>
> = {};

type Json = Record<string, any>;

const id = (n: number) => `a6b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L = {
  owner: id(1),
  adminAll: id(2),
  adminNoUsers: id(3),
  modP: id(4),
  userQ: id(6),
  outsider: id(7),
} as const;
type LoginKey = keyof typeof L;
const LOGINS = Object.keys(L) as LoginKey[];
const ADMINS: readonly LoginKey[] = ['owner', 'adminAll', 'adminNoUsers'];
const W = { P: id(101), Q: id(102) };
const AG = { admin: id(401), P: id(402), Q: id(403) };

describe.skipIf(!URL)('the A6b exit sweep', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let content: typeof import('@mantle/content');
  let files: typeof import('@mantle/files');
  let rt: typeof import('@mantle/runtime/agent');
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let cookieOf: (login: string) => string;
  let adminWs = '';

  const names = new Map<string, string>();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A value with every known id named, unknown ids, times and secrets
   *  blanked (so a cell reads the same on every run). */
  const norm = (v: unknown): unknown => {
    let s = JSON.stringify(v, (_k, val) => (val instanceof Map ? Object.fromEntries(val) : val));
    if (s === undefined) return null;
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
      return names.get(u.toLowerCase()) ?? '<uuid>';
    });
    s = s.replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g,
      '<time>',
    );
    s = s.replace(/mtlk_[A-Za-z0-9_-]+/g, '<key>');
    s = s.replace(/"(sha256|etag|version|appVersion)":"[^"]*"/g, '"$1":"<x>"');
    return JSON.parse(s);
  };

  /** The answer of `fn`, or the refusal it threw. */
  const answer = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return { ok: await fn() };
    } catch (err) {
      const e = err as { status?: number; code?: string; name?: string; message?: string };
      return {
        refused: {
          name: e.name,
          status: e.status ?? null,
          code: e.code ?? null,
          message: e.message,
        },
      };
    }
  };

  // ── contexts ───────────────────────────────────────────────────────────
  const isAdmin = (who: LoginKey) => ADMINS.includes(who);
  /** A login's request, as the session guard enters it: a read and a
   *  member's write in the login's scope (a write on the write role), an
   *  Admin user's write on the system pool with its scope noted. */
  const inRequest = async <T>(who: LoginKey, write: boolean, fn: () => Promise<T>) => {
    const scope = await m.viewerScopeFor({ login: L[who] });
    return m.runInRequestSlot(async () => {
      if (isAdmin(who) && write) m.noteRequestWriteScope(scope);
      else m.enterRequestScope(scope, { writes: write, drafts: isAdmin(who) });
      return fn();
    });
  };
  /** An assistant's turn: Admin's, P's or Q's, answering `who` (or none). */
  const inTurn = <T>(ag: keyof typeof AG, who: LoginKey | null, fn: () => Promise<T>) =>
    rt.withAgentScope(
      { id: AG[ag], workspaceId: ag === 'admin' ? adminWs : W[ag] },
      fn,
      who ? (ag === 'admin' ? { ownerLoginId: L[who] } : { loginId: L[who] }) : {},
    );
  /** Every context a library runs in, by name. */
  const CONTEXTS: ReadonlyArray<[string, <T>(fn: () => Promise<T>) => Promise<T>]> = [
    ['system', (fn) => fn()],
    ...LOGINS.flatMap(
      (who) =>
        [
          [`read:${who}`, (fn) => inRequest(who, false, fn)],
          [`write:${who}`, (fn) => inRequest(who, true, fn)],
        ] as [string, <T>(fn: () => Promise<T>) => Promise<T>][],
    ),
    ['turn:admin:owner', (fn) => inTurn('admin', 'owner', fn)],
    ['turn:admin:adminAll', (fn) => inTurn('admin', 'adminAll', fn)],
    ['turn:admin:none', (fn) => inTurn('admin', null, fn)],
    ['turn:P:modP', (fn) => inTurn('P', 'modP', fn)],
    ['turn:P:none', (fn) => inTurn('P', null, fn)],
    ['turn:Q:userQ', (fn) => inTurn('Q', 'userQ', fn)],
  ];

  /** A request through the real app as `who` (null: no session). */
  const http = async (who: LoginKey | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who) headers.cookie = cookieOf(L[who]);
    const res = await app.request(path, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    }
    return { status: res.status, body: parsed };
  };

  // ── sections ───────────────────────────────────────────────────────────
  /** Run one section: its cells, then record (A6B_RECORD) or compare. */
  const section = async (
    name: string,
    body: (cell: (k: string, v: unknown) => void) => Promise<void>,
  ) => {
    const cells: string[] = [];
    // A cell carries the check misses (warn: what on refuses) and the
    // write role's gaps its own statements met, taken after each cell.
    m.takeActorMisses();
    m.takeWriteRoleGaps();
    await body((k, v) => {
      const misses = [...new Set(m.takeActorMisses().map((x) => `${x.source} ${x.check}`))].sort();
      const gaps = [...new Set(m.takeWriteRoleGaps())].sort();
      const out = misses.length || gaps.length ? { v, misses, gaps } : v;
      cells.push(`${k} => ${JSON.stringify(norm(out))}`);
    });
    const path = snapOf(name);
    if (RECORD.has(name) || RECORD.has('all')) {
      writeFileSync(path, `${cells.join('\n')}\n`);
      return;
    }
    expect(existsSync(path), `${path}: record it on main (A6B_RECORD=${name})`).toBe(true);
    const recorded = readFileSync(path, 'utf8').trimEnd().split('\n');
    const was = new Map(recorded.map((l) => [l.slice(0, l.indexOf(' => ')), l]));
    const now = new Map(cells.map((l) => [l.slice(0, l.indexOf(' => ')), l]));
    const problems: string[] = [];
    for (const [k, line] of was) {
      const cur = now.get(k);
      if (cur === undefined) {
        problems.push(`missing: ${k}`);
        continue;
      }
      if (cur === line) continue;
      const named = (NAMED_CHANGES[name] ?? []).find((c) => c.cells.test(k));
      const value = cur.slice(cur.indexOf(' => ') + 4);
      if (named && `${k} => ${named.back(value)}` === line) continue;
      problems.push(`changed: ${line}\n     now: ${cur}`);
    }
    for (const k of now.keys()) if (!was.has(k)) problems.push(`new cell: ${k}`);
    expect(problems, `section ${name} (${MODE})`).toEqual([]);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a6b-exit-sweep-secret-at-least-32-characters';
    process.env.MANTLE_FILES_ROOT = mkdtempSync(join(tmpdir(), 'a6b-files-'));
    delete process.env.MANTLE_ADMIN_READS;
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    content = await import('@mantle/content');
    files = await import('@mantle/files');
    rt = await import('@mantle/runtime/agent');

    for (const [k, v] of Object.entries(L)) names.set(v, `login:${k}`);
    for (const [k, v] of Object.entries(W)) names.set(v, `ws:${k}`);
    for (const [k, v] of Object.entries(AG)) names.set(v, `agent:${k}`);
    for (const k of LOGINS) {
      await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
                  values (${L[k]}, ${`a6b-${k}@example.invalid`}, 'x', ${k === 'owner'},
                          ${isAdmin(k) ? 'admin' : 'member'}, ${k})`);
    }
    await x(sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
                on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const [adm] = await x<{ id: string }>(
      sql`select id::text as id from workspaces where owner_id = ${L.owner} and is_admin`,
    );
    adminWs = adm!.id;
    names.set(adminWs, 'ws:Admin');
    await x(sql`insert into workspaces (id, owner_id, name) values
      (${W.P}, ${L.owner}, 'Proj'), (${W.Q}, ${L.owner}, 'Quay')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
        (${adminWs}, ${L.adminAll}, false), (${adminWs}, ${L.adminNoUsers}, false),
        (${W.P}, ${L.owner}, true), (${W.P}, ${L.modP}, true),
        (${W.Q}, ${L.modP}, false), (${W.Q}, ${L.userQ}, false)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`);
    await x(sql`update workspace_users set limits = '{"areas":{"users":false}}'::jsonb
                 where workspace_id = ${adminWs} and login_id = ${L.adminNoUsers}`);
    for (const w of await x<{ id: string; name: string }>(
      sql`select id::text as id, name from workspaces where owner_id = ${L.owner}`,
    )) {
      if (!names.has(w.id)) names.set(w.id, `ws:other(${w.name})`);
    }
    // The assistants: Admin's, P's and Q's.
    for (const [k, wid] of [
      ['admin', adminWs],
      ['P', W.P],
      ['Q', W.Q],
    ] as const) {
      await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, workspace_id, memory_config)
                  values (${AG[k]}, ${L.owner}, ${`a6b-${k}`}, ${`${k} assistant`}, 'test/model', 'p', ${wid},
                          '{"chunk_limit":0,"content_hit_limit":0,"corpus_map_limit":0}'::jsonb)`);
    }

    const tokens = await import('../lib/auth/tokens');
    cookieOf = (login) => `mantle_session=${tokens.buildSessionCookie(login).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  // ── owner-preferences: loadProfilePreferences, the landing's site name ──
  it('owner-preferences', async () => {
    await x(sql`insert into profiles (user_id, preferences) values
      (${L.owner}, ${JSON.stringify({ timezone: 'Europe/Berlin', siteName: 'Sweep Brain', locale: 'de-DE' })}::jsonb),
      (${L.adminAll}, ${JSON.stringify({ timezone: 'Pacific/Auckland' })}::jsonb),
      (${L.modP}, ${JSON.stringify({ timezone: 'Asia/Tokyo', siteName: 'not the brand' })}::jsonb),
      (${L.userQ}, ${JSON.stringify({ timezone: 'America/Lima' })}::jsonb)
      on conflict (user_id) do update set preferences = excluded.preferences`);
    const pick = (p: Json) => ({ tz: p.timezone, site: p.siteName ?? null, locale: p.locale });
    await section('owner-preferences', async (cell) => {
      for (const [ctx, run] of CONTEXTS) {
        for (const target of ['owner', 'adminAll', 'modP', 'userQ'] as const) {
          cell(
            `prefs ${ctx} of=${target}`,
            await answer(() =>
              run(async () => pick(await content.loadProfilePreferences(L[target]))),
            ),
          );
        }
      }
      for (const who of LOGINS) {
        cell(`GET /api/home ${who}`, await http(who, 'GET', '/api/home'));
        cell(`GET /api/home?ws=P ${who}`, await http(who, 'GET', `/api/home?ws=${W.P}`));
        cell(`GET /api/member/home ${who}`, await http(who, 'GET', '/api/member/home'));
      }
      // The anchor's row missing: a member's landing (the profile row is
      // made on its first read).
      await x(sql`delete from profiles where user_id = ${L.owner}`);
      cell('missing GET /api/home?ws=P modP', await http('modP', 'GET', `/api/home?ws=${W.P}`));
      cell(
        'missing anchor row after',
        await x(sql`select preferences from profiles where user_id = ${L.owner}`),
      );
      await x(sql`delete from profiles where user_id = ${L.owner}`);
      cell(
        'missing prefs turn:admin:adminAll of=owner',
        await answer(() =>
          inTurn('admin', 'adminAll', async () =>
            pick(await content.loadProfilePreferences(L.owner)),
          ),
        ),
      );
      cell(
        'missing anchor row after turn',
        await x(sql`select preferences from profiles where user_id = ${L.owner}`),
      );
      await x(sql`insert into profiles (user_id, preferences) values
        (${L.owner}, ${JSON.stringify({ timezone: 'Europe/Berlin', siteName: 'Sweep Brain', locale: 'de-DE' })}::jsonb)
        on conflict (user_id) do update set preferences = excluded.preferences`);
    });
  });

  // ── kind-root: the files root, read whatever the scope holds ───────────
  it('kind-root', async () => {
    const rootRows = () =>
      x<{ n: number }>(
        sql`select count(*)::int as n from nodes where owner_id = ${L.owner} and type = 'branch' and path::text = 'files'`,
      );
    await section('kind-root', async (cell) => {
      // No root yet: a member's list makes it (the read path's repair).
      cell('root before', await rootRows());
      cell(
        'GET files root modP (no root)',
        await http('modP', 'GET', '/api/files/files?parent=files'),
      );
      cell('root after modP list', await rootRows());
      for (const [ctx, run] of CONTEXTS) {
        cell(
          `ensureFilesRootBranch ${ctx}`,
          await answer(() =>
            run(async () => (await files.ensureFilesRootBranch(L.owner)) !== null),
          ),
        );
      }
      for (const who of LOGINS) {
        cell(`GET files root ${who}`, await http(who, 'GET', '/api/files/files?parent=files'));
        const filename = `kr-${who}.txt`;
        cell(
          `POST file at root ${who}`,
          await http(who, 'POST', '/api/files/files', {
            parentPath: 'files',
            filename,
            content: `from ${who}`,
            confirm: true,
          }),
        );
        cell(
          `row of ${filename}`,
          await x(sql`select n.title, n.path::text as path,
                             (select array_agg(g.workspace_id::text order by g.workspace_id)
                                from item_grants g where g.node_id = n.id) as held
                        from nodes n where n.owner_id = ${L.owner} and n.type = 'file'
                         and n.data->>'filename' = ${filename}`),
        );
        cell(
          `POST same name at root ${who}`,
          await http(who, 'POST', '/api/files/files', {
            parentPath: 'files',
            filename: 'kr-owner.txt',
            content: `over by ${who}`,
            confirm: true,
          }),
        );
      }
      // upsertFile itself, at the root, in every context.
      let n = 0;
      for (const [ctx, run] of CONTEXTS) {
        n += 1;
        const filename = `kr-lib-${n}.txt`;
        cell(
          `upsertFile root ${ctx}`,
          await answer(() =>
            run(async () => {
              const f = await files.upsertFile({
                ownerId: L.owner,
                parentPath: 'files',
                filename,
                bytes: Buffer.from(`lib ${ctx}`),
              });
              return { filename: f.filename, parentPath: f.parentPath };
            }),
          ),
        );
        cell(
          `row of ${filename}`,
          await x(sql`select (select array_agg(g.workspace_id::text order by g.workspace_id)
                                from item_grants g where g.node_id = n.id) as held
                        from nodes n where n.owner_id = ${L.owner} and n.type = 'file'
                         and n.data->>'filename' = ${filename}`),
        );
      }
    });
  });
});
