/**
 * POST /api/tables/import through the full HTTP pipeline (runRoute: the gate,
 * the row, the body ceiling, the handler), on a migrated scratch database, in
 * the checks' `on`, as on the fleet. The parser service is stood in by the
 * parser's own workbook reader (a real .xls conversion is the parser's own
 * test, legacy-sheet.test.ts); a CSV is read for real, in this process.
 *
 *  1. whoever may press New table gets a Table from xlsx, xls and csv, with every
 *     sheet with rows as a tab, where New table would put it, committed, and no
 *     file in Files;
 *  2. a read key, a write key and a contact are refused, and nothing is made;
 *  3. a body over the cap is refused before any parse, declared or chunked, and
 *     a bad type is refused;
 *  4. a file that cannot be read gets fixed words, never the parser's;
 *  5. the row holds the limit, and the route does not take /api/tables/:id.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/tables-import-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { workbookBuffer } from '../../../packages/files/src/sheet-fixtures.test-helper';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
const MB = 1024 * 1024;

const parser = vi.hoisted(() => ({ exts: [] as string[], fail: null as Error | null }));

vi.mock('../../../packages/files/src/parser-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parserGrid: vi.fn(async (bytes: Buffer, ext: string) => {
    parser.exts.push(ext);
    if (parser.fail) throw parser.fail;
    const { parseSheetToGrid } = await import('../../../packages/files/src/sheet-grid');
    return { sheets: await parseSheetToGrid(bytes), plan: null };
  }),
}));

type Table = {
  id: string;
  title: string;
  draft: unknown;
  rowCount: number;
  data: { rows: unknown[]; columns: { name: string; type: string }[] };
  tabs: { name: string; rows: number; columns: number }[];
};

describe.skipIf(!DB_URL)('POST /api/tables/import', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `tim${randomUUID().slice(0, 6)}`;
  const L = { owner: randomUUID(), member: randomUUID(), plain: randomUUID() };
  /** The member moderates `moderated` and only reads `reads`; it is not in `other`. */
  const ws = { admin: '', moderated: '', reads: '', other: '' };
  let xlsx: Buffer;

  const form = (name: string, bytes: Buffer | string) => {
    const f = new FormData();
    f.set('file', new File([new Uint8Array(Buffer.from(bytes))], name));
    return f;
  };
  const send = async (
    who: Parameters<typeof runRoute>[0],
    body: BodyInit,
    query = '',
    headers: Record<string, string> = {},
  ) => {
    const res = await runRoute(who, 'POST', `/api/tables/import${query}`, undefined, {
      rawBody: body,
      headers,
    });
    const text = await res.text();
    let json: { table?: Table; error?: string; reason?: string } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // not JSON: the status says it
    }
    return { status: res.status, text, json };
  };
  const made = async (res: Awaited<ReturnType<typeof send>>): Promise<Table> => {
    expect(res.status, res.text).toBe(201);
    return res.json.table!;
  };
  const homeOf = async (id: string) =>
    (
      await raw<{ ws: string }[]>`select workspace_id::text as ws from item_grants
        where node_id = ${id} and is_home`
    ).map((r) => r.ws);
  const count = async (type: string) =>
    (await raw<{ n: number }[]>`select count(*)::int as n from nodes where type = ${type}`)[0]!.n;
  /** The home New table would give this caller and query. */
  const newTableHome = async (who: string, query = '') => {
    const res = await runRoute(who, 'POST', `/api/tables${query}`, { title: `${tag} new` });
    const text = await res.text();
    expect(res.status, text).toBe(201);
    return homeOf((JSON.parse(text) as { table: Table }).table.id);
  };
  /** Refused: no Table more than before, no parser call. */
  const refusedNothingMade = async (fn: () => ReturnType<typeof send>) => {
    const tables = await count('table');
    parser.exts = [];
    const res = await fn();
    expect(parser.exts, 'no parse').toEqual([]);
    expect(await count('table'), res.text).toBe(tables);
    return res;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'tables-import-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'tables-import-route-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the import test', { status: 503 })),
    );
    m = await import('@mantle/db');
    actorMode = await import('../../../packages/db/src/actor');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      const role = who === 'owner' ? 'admin' : 'member';
      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'}, ${role}, ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
        where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    for (const k of ['moderated', 'reads', 'other'] as const) {
      ws[k] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${L.owner}, ${`${tag} ${k}`}) returning id::text as id`
      )[0]!.id;
    }
    await raw`delete from workspace_users where login_id in (${L.member}, ${L.plain})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.moderated}, ${L.member}, true),
      (${ws.reads}, ${L.member}, false),
      (${ws.reads}, ${L.plain}, false)`;
    await raw`select mantle_set_actor_check('on', 50, 'test')`;
    await raw`select mantle_set_edit_check('on', 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = 'on';
    actorMode.noteBoxActorCheckMode('on');
    xlsx = await workbookBuffer({
      Lines: [
        ['Tag', 'Size'],
        ['V-101', 150],
        ['V-102', 200],
      ],
      Valves: [['Valve'], ['A'], ['B'], ['C']],
      Empty: [],
    });
    m.takeActorMisses();
  }, 300_000);

  afterEach(() => {
    parser.fail = null;
    parser.exts = [];
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe('a person who may press New table', () => {
    it('xlsx: every sheet with rows is a tab, in the ?ws= workspace, committed', async () => {
      const table = await made(
        await send(L.member, form(`${tag} lines.xlsx`, xlsx), `?ws=${ws.moderated}`),
      );
      expect(parser.exts).toEqual(['xlsx']);
      expect(table.title).toBe(`${tag} lines`);
      expect(table.tabs.map((t) => [t.name, t.rows, t.columns])).toEqual([
        ['Lines', 2, 2],
        ['Valves', 3, 1],
      ]);
      expect(table.draft).toBeNull();
      expect(await homeOf(table.id)).toEqual([ws.moderated]);
      // The member reads it back, by the Table's own route.
      const back = await runRoute(L.member, 'GET', `/api/tables/${table.id}`);
      expect(back.status).toBe(200);
      expect(((await back.json()) as { table: Table }).table.tabs).toHaveLength(2);
    });

    it('xls: the same, by the same parse', async () => {
      const table = await made(
        await send(L.member, form(`${tag} old.XLS`, xlsx), `?ws=${ws.moderated}`),
      );
      expect(parser.exts).toEqual(['xls']);
      expect(table.title).toBe(`${tag} old`);
      expect(table.tabs.map((t) => t.name)).toEqual(['Lines', 'Valves']);
      expect(await homeOf(table.id)).toEqual([ws.moderated]);
    });

    it('csv: read here, with no parser call, one tab', async () => {
      const table = await made(
        await send(
          L.member,
          form(`${tag} c.csv`, 'Tag,Size\nV-1,10\nV-2,20\n'),
          `?ws=${ws.moderated}`,
        ),
      );
      expect(parser.exts).toEqual([]);
      expect(table.tabs.map((t) => [t.rows, t.columns])).toEqual([[2, 2]]);
      expect(table.data.columns.map((c) => c.type)).toEqual(['text', 'number']);
      expect(await homeOf(table.id)).toEqual([ws.moderated]);
    });

    it('lands where New table lands, for every caller and query', async () => {
      const cases: [string, string][] = [
        [L.member, `?ws=${ws.moderated}`],
        // Only reads it: as if it had named none.
        [L.member, `?ws=${ws.reads}`],
        [L.member, ''],
        [L.plain, ''],
        [L.owner, ''],
        [L.owner, `?ws=${ws.admin}`],
      ];
      for (const [who, query] of cases) {
        const table = await made(await send(who, form(`${tag} h.csv`, 'A\n1\n'), query));
        expect(await homeOf(table.id), `${who} ${query}`).toEqual(await newTableHome(who, query));
      }
    });

    it('a workspace the caller is not in is refused, as New table refuses it', async () => {
      const res = await refusedNothingMade(() =>
        send(L.member, form(`${tag} x.csv`, 'A\n1\n'), `?ws=${ws.other}`),
      );
      expect(res.status).toBe(403);
      const plain = await runRoute(L.member, 'POST', `/api/tables?ws=${ws.other}`, { title: 'x' });
      expect(plain.status).toBe(403);
    });

    it('answers as POST /api/tables does, the first tab windowed', async () => {
      const created = await runRoute(L.member, 'POST', '/api/tables', { title: `${tag} shape` });
      const plain = ((await created.json()) as { table: Table }).table;
      const lines = ['Tag,Size'];
      for (let i = 0; i < 10_500; i += 1) lines.push(`V-${i},${i}`);
      const res = await send(L.member, form(`${tag} big.csv`, lines.join('\n')));
      expect(res.status).toBe(201);
      const table = res.json.table!;
      expect(Object.keys(table)).toEqual(expect.arrayContaining(Object.keys(plain)));
      expect(table.rowCount).toBe(10_500);
      expect(table.data.rows.length).toBeLessThanOrEqual(10_000);
    });

    it('no file lands in Files', async () => {
      const files = await count('file');
      const table = await made(await send(L.member, form(`${tag} f.xlsx`, xlsx)));
      expect(await count('file')).toBe(files);
      const root = process.env.MANTLE_FILES_ROOT!;
      expect(existsSync(root) ? readdirSync(root, { recursive: true }) : []).toEqual([]);
      const [row] = await raw<{ source: string | null }[]>`
        select data->>'sourceFileId' as source from nodes where id = ${table.id}`;
      expect(row!.source).toBeNull();
    });

    it('a text value past row 50 of a number column stays a value', async () => {
      const lines = ['Tag,Size'];
      for (let i = 2; i <= 60; i += 1) lines.push(`V-${i},${i === 55 ? 'N/A' : i}`);
      const table = await made(await send(L.member, form(`${tag} n.csv`, lines.join('\n'))));
      expect(table.data.columns[1]!.type).toBe('text');
      expect(JSON.stringify(table.data.rows)).toContain('N/A');
    });
  });

  describe('those who may not', () => {
    const key = async (access: 'read' | 'read_write') => {
      const { mintAccessKey } = await import('../lib/access-keys');
      const minted = await mintAccessKey({
        loginId: L.member,
        name: `${tag} ${access}`,
        access,
        areas: null,
        riskyTools: [],
        expiresAt: null,
        createdBy: L.member,
        maxLive: 10,
      });
      return minted!.key;
    };

    it.each(['read', 'read_write'] as const)(
      'a %s key is refused: the route is no API',
      async (a) => {
        const secret = await key(a);
        const res = await refusedNothingMade(() =>
          send({ key: secret }, form(`${tag} k.csv`, 'A\n1\n')),
        );
        expect([401, 403]).toContain(res.status);
      },
    );

    it('a contact has no login: its visitor cookie is refused', async () => {
      const { CONTACT_VISITOR_COOKIE, buildContactVisitorValue } = await import('../lib/auth');
      const { value } = buildContactVisitorValue({
        contactId: randomUUID(),
        ownerId: L.owner,
        codeEpoch: 0,
      });
      const res = await refusedNothingMade(() =>
        send(null, form(`${tag} c.csv`, 'A\n1\n'), '', {
          cookie: `${CONTACT_VISITOR_COOKIE}=${value}`,
        }),
      );
      expect(res.status).toBe(401);
    });

    it('no credential is refused', async () => {
      const res = await refusedNothingMade(() => send(null, form(`${tag} n.csv`, 'A\n1\n')));
      expect(res.status).toBe(401);
    });
  });

  describe('the body', () => {
    it('a declared length over the ceiling is refused before the handler', async () => {
      const res = await refusedNothingMade(() =>
        send(L.member, form(`${tag} d.xlsx`, xlsx), '', {
          'content-length': String(70 * MB),
        }),
      );
      expect(res.status).toBe(413);
      expect(res.json.reason).toBe('body-too-large');
    });

    it('a chunked body over the ceiling is refused before any parse', async () => {
      let sent = 0;
      const chunk = new Uint8Array(MB);
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (sent >= 70) return ctrl.close();
          sent += 1;
          ctrl.enqueue(chunk);
        },
      });
      const res = await refusedNothingMade(() =>
        send(L.member, stream, '', { 'content-type': 'multipart/form-data; boundary=x' }),
      );
      expect(res.status).toBe(413);
      expect(res.json.reason).toBe('body-too-large');
      expect(sent).toBeLessThan(70);
    });

    it('a file over 64 MB inside the framing room is refused before any parse', async () => {
      const res = await refusedNothingMade(() =>
        send(L.member, form(`${tag} big.xlsx`, Buffer.alloc(64 * MB + 1024))),
      );
      expect(res.status).toBe(413);
      expect(res.json.reason).toBe('body-too-large');
    });

    it('a bad type is refused, and no file field is refused', async () => {
      for (const name of [`${tag}.txt`, `${tag}.xlsm`, `${tag}.csv.exe`, tag]) {
        const res = await refusedNothingMade(() => send(L.member, form(name, 'A\n1\n')));
        expect(res.status, name).toBe(400);
        expect(res.json.error, name).toBe('expected a .xlsx / .xls / .csv file');
      }
      const none = new FormData();
      none.set('title', 'no file');
      expect((await refusedNothingMade(() => send(L.member, none))).status).toBe(400);
    });

    it('over the import cap answers by the one table, and nothing is made', async () => {
      vi.stubEnv('TABLE_IMPORT_MAX_ROWS', '2');
      const res = await refusedNothingMade(() =>
        send(L.member, form(`${tag} cap.csv`, 'A\n1\n2\n3\n')),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('a file that cannot be read', () => {
    const LEAK = 'secret path /opt/parser/job-42';
    it('a final failure gets fixed words, never the parser text', async () => {
      const { ParserError } = await import('@mantle/files');
      parser.fail = new ParserError('failed', LEAK, { retryable: false, terminal: true });
      const res = await send(L.member, form(`${tag} bad.xlsx`, xlsx));
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('This file could not be read as a spreadsheet.');
      expect(res.text).not.toContain('parser');
    });

    it('a final too_large says to save it as CSV', async () => {
      const { ParserError } = await import('@mantle/files');
      parser.fail = new ParserError('too_large', LEAK, { retryable: false, terminal: true });
      const res = await send(L.member, form(`${tag} huge.xlsx`, xlsx));
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('Save it as CSV');
    });

    it('a busy parser is no word on the file: the opaque 500, and no Table', async () => {
      const { ParserError } = await import('@mantle/files');
      parser.fail = new ParserError('busy', LEAK, { retryable: true, terminal: false });
      const tables = await count('table');
      const res = await send(L.member, form(`${tag} busy.xlsx`, xlsx));
      expect(res.status).toBe(500);
      expect(res.text).not.toContain('parser');
      expect(await count('table')).toBe(tables);
    });

    it('a CSV with a stray quote gets the same words', async () => {
      const res = await send(L.member, form(`${tag} q.csv`, 'A,B\n"x,1\n2,"y\nz"z,3\n'));
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('This file could not be read as a spreadsheet.');
    });

    it('no rows: a header alone makes no Table', async () => {
      const res = await refusedNothingMade(() => send(L.member, form(`${tag} h.csv`, 'A,B\n')));
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('no tabular data found');
    });
  });

  describe('the row', () => {
    it('holds the limit, and takes a create home', async () => {
      const { routeManifest } = await import('./route-manifest.gen');
      const { buildRoutePolicy } = await import('../lib/auth/route-policy');
      const row = buildRoutePolicy(routeManifest).get('POST /api/tables/import')!;
      expect(row.rateLimit).toEqual(['tablesImport']);
      expect(row.creates).toBe(true);
      expect(row.logins).toBe('owner');
      const { RATE_LIMITS } = await import('../lib/route-limits');
      expect(RATE_LIMITS.tablesImport).toMatchObject({ per: 'login', max: 30 });
    });

    it('sits beside /api/tables/:id: it takes a POST only, and an id still reaches its own import', async () => {
      const get = await runRoute(L.member, 'GET', '/api/tables/import');
      expect(get.status).toBe(405);
      const of = await runRoute(L.owner, 'POST', `/api/tables/${randomUUID()}/import`, undefined, {
        rawBody: form(`${tag} i.csv`, 'A\n1\n'),
      });
      expect(of.status).toBe(404);
    });
  });
});
