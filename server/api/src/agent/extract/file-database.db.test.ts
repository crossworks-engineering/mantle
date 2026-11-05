/**
 * The writer: what one extract writes for a table-type file, a database, a
 * word, a Table, or nothing, on a real migrated Postgres and a real files root.
 * The parser is faked at the fetch and counted; the file's bytes are real.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/file-database.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Reply = () => Response;
const h = vi.hoisted(() => ({
  /** Whole-file reads, by node id. */
  reads: [] as string[],
  /** Runs inside the next parser call, once. */
  duringParser: null as null | (() => Promise<void>),
  /** Runs right after the next word is written, once. */
  afterWord: null as null | (() => Promise<void>),
}));

vi.mock('./file-bytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bytes')>();
  return {
    ...actual,
    loadFileBytes: (node: { id: string }) => {
      h.reads.push(node.id);
      return actual.loadFileBytes(node as never);
    },
  };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    writeFileDbNone: async (...args: Parameters<typeof actual.writeFileDbNone>) => {
      const out = await actual.writeFileDbNone(...args);
      const hook = h.afterWord;
      h.afterWord = null;
      if (hook) await hook();
      return out;
    },
  };
});

const SHEET = {
  name: 'Lines',
  columns: [
    { name: 'Tag', type: 'text' },
    { name: 'Size', type: 'number' },
  ],
  rows: [
    ['P-101', 50],
    ['P-102', 80],
  ],
};
const grid =
  (sheets: unknown[] = [SHEET], plan: unknown = null): Reply =>
  () =>
    Response.json({ sheets, plan });
const failing =
  (code: string, status: number, final = false): Reply =>
  () =>
    Response.json({ ok: false, error: { code, message: code, final } }, { status });

describe.skipIf(!URL)('the writer of a file database', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('@mantle/files');
  let m: Db;
  let f: Files;
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.m1';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-file-db-'));

  let reply: Reply = grid();
  const parserCalls: string[] = [];

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A folder homed in `ws`. Its files take that home. */
  const folderIn = (ws: string, folder: string) =>
    m.withCreateHome({ createWs: ws, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: folder }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${randomUUID()}, ${anchor}, 'branch', ${folder}, ${folder}::ltree)`),
      ),
    );
  /** An upload, or a replace of the same name, in the team's folder. */
  const upload = async (name: string, bytes: Buffer | string, ws = team, folder = FOLDER) =>
    m.withCreateHome({ createWs: ws, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: folder,
        filename: name,
        bytes: Buffer.from(bytes),
        overwrite: true,
      }),
    );
  const unique = (ext: string) => `${randomUUID().slice(0, 8)}.${ext}`;

  const nodeRow = async (id: string) => {
    const { eq } = await import('drizzle-orm');
    const [row] = await m.db.select().from(m.nodes).where(eq(m.nodes.id, id)).limit(1);
    return row!;
  };
  const shaOf = async (id: string) =>
    ((await nodeRow(id)).data as Record<string, unknown>).sha256 as string;
  const pass = async (id: string) => maybeAutoTableSpreadsheet(await nodeRow(id), anchor);
  const tablesOf = (id: string) =>
    x<{ id: string }>(sqlTag`
      select id from nodes where type = 'table' and data->>'sourceFileId' = ${id}`);
  const namesOf = (id: string) =>
    existsSync(f.fileDbsDir())
      ? readdirSync(f.fileDbsDir())
          .filter((n) => n.startsWith(id))
          .map((n) => n.slice(id.length + 1))
          .sort()
      : [];
  const sqliteName = (sha: string) => `${sha.slice(0, 16)}.sqlite`;
  const noneName = (sha: string) => `${sha.slice(0, 16)}.none`;
  /** Mark a row's extract done, as the extractor leaves it. */
  const completed = (id: string) =>
    x(sqlTag`update nodes set data = data - 'index_work'
      || jsonb_build_object('extract_completed_at', now()::text) where id = ${id}`);

  /** The database's rows and `_meta`, read as a reader would: read-only. */
  const open = (abs: string) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    return new DatabaseSync(abs, { readOnly: true });
  };

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    ({ maybeAutoTableSpreadsheet } = await import('./auto-table'));
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    await su(sqlTag`insert into workspaces (id, owner_id, name)
      values (${team}, ${anchor}, ${`team ${team.slice(0, 8)}`})`);
    // As a brain has it: homes need the Admin workspace.
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await folderIn(team, FOLDER);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    reply = grid();
    parserCalls.length = 0;
    h.reads.length = 0;
    h.duringParser = null;
    h.afterWord = null;
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        parserCalls.push(String(url));
        const hook = h.duringParser;
        h.duringParser = null;
        if (hook) await hook();
        return reply();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('a new upload', () => {
    it('with no line: the database and the Table, from one parse', async () => {
      const file = await upload(unique('xlsx'), 'workbook one');
      await pass(file.id);
      expect(parserCalls).toHaveLength(1);
      expect(h.reads).toEqual([file.id]);
      expect(await tablesOf(file.id)).toHaveLength(1);
      const sha = await shaOf(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(sha)]);
      const db = open(f.fileDbPaths(file.id, sha)!.sqlite);
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(db.prepare(`SELECT "Tag", "Size" FROM "Lines" ORDER BY _pos`).all()).toEqual([
        { Tag: 'P-101', Size: 50 },
        { Tag: 'P-102', Size: 80 },
      ]);
      expect(
        db.prepare(`SELECT count(*) AS n FROM t_t1_fts WHERE t_t1_fts MATCH '"P-102"'`).get(),
      ).toEqual({
        n: 1,
      });
      db.close();
    });

    it('with the line: the database and no Table', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'workbook line');
      await pass(file.id);
      expect(await tablesOf(file.id)).toEqual([]);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
    });

    it('every sheet with rows is a tab, past the Table cap of 20', async () => {
      const sheets = Array.from({ length: 25 }, (_, i) => ({ ...SHEET, name: `S${i}` }));
      sheets.push({ ...SHEET, name: 'Empty', rows: [] });
      reply = grid(sheets);
      const file = await upload(unique('xlsx'), 'workbook many');
      await pass(file.id);
      const db = open(f.fileDbPaths(file.id, await shaOf(file.id))!.sqlite);
      expect(db.prepare(`SELECT count(*) AS n FROM _tabs`).get()).toEqual({ n: 25 });
      db.close();
      const [t] = await tablesOf(file.id);
      const counts = await x<{ n: number }>(sqlTag`
        select jsonb_array_length(stats->'tabs') as n from tables where node_id = ${t!.id}`);
      expect(counts).toEqual([{ n: 20 }]);
    });

    it('a plan keeps its description in _meta', async () => {
      reply = grid([SHEET], { taskCount: 3, summaryCount: 1 });
      const plan = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks/></Project>';
      const file = await upload(unique('xml'), plan);
      await pass(file.id);
      const db = open(f.fileDbPaths(file.id, await shaOf(file.id))!.sqlite);
      const row = db.prepare(`SELECT v FROM _meta WHERE k = 'description'`).get() as { v: string };
      expect(row.v).toMatch(/1 of 3 rows in Tasks/);
      db.close();
    });

    it('a non-plan XML gets no name and asks no parser', async () => {
      const file = await upload(unique('xml'), '<Invoice><Total>9</Total></Invoice>');
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([]);
      expect(parserCalls).toEqual([]);
    });

    it('an XML with a Project root that is no plan: no-rows', async () => {
      const file = await upload(unique('xml'), '<Project><Name>x</Name></Project>');
      await pass(file.id);
      const sha = await shaOf(file.id);
      expect(namesOf(file.id)).toEqual([noneName(sha)]);
      expect(await f.readFileDbNone(file.id, sha)).toBe('no-rows');
    });
  });

  describe('the words', () => {
    const wordOf = async (id: string) => f.readFileDbNone(id, await shaOf(id));

    it('a CSV with a stray quote writes unreadable, and no Table', async () => {
      const file = await upload(unique('csv'), 'tag,size\n"P-101,50\n');
      await pass(file.id);
      expect(await wordOf(file.id)).toBe('unreadable');
      expect(await tablesOf(file.id)).toEqual([]);
    });

    it('no sheets or no rows writes no-rows', async () => {
      const header = await upload(unique('csv'), 'tag,size\n');
      await pass(header.id);
      expect(await wordOf(header.id)).toBe('no-rows');
      reply = grid([]);
      const empty = await upload(unique('xlsx'), 'workbook empty');
      await pass(empty.id);
      expect(await wordOf(empty.id)).toBe('no-rows');
    });

    it('past TABLE_IMPORT_MAX_ROWS writes too-large', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      vi.stubEnv('TABLE_IMPORT_MAX_ROWS', '1');
      const file = await upload(unique('xlsx'), 'workbook rows');
      await pass(file.id);
      expect(await wordOf(file.id)).toBe('too-large');
    });

    it('a CSV past the cap with no Table wanted: too-large with no parse', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
      const bytes = Buffer.concat([Buffer.from('tag\n"x\n'), Buffer.alloc(1024 * 1024 + 1, 97)]);
      const file = await upload(unique('csv'), bytes);
      await pass(file.id);
      expect(await wordOf(file.id)).toBe('too-large');
    });

    it('a final too_large writes too-large, and the extract goes on', async () => {
      reply = failing('too_large', 413, true);
      const file = await upload(unique('xlsx'), 'workbook final');
      await pass(file.id);
      expect(await wordOf(file.id)).toBe('too-large');
    });

    it('a second run does nothing: the word holds', async () => {
      const file = await upload(unique('csv'), 'tag,size\n"P-101,50\n');
      await pass(file.id);
      h.reads.length = 0;
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      await pass(file.id);
      expect(h.reads).toEqual([]);
    });
  });

  describe('an error that is no verdict', () => {
    it('a workbook timeout throws fatal and writes no name; the retry builds', async () => {
      reply = failing('timeout', 504);
      const file = await upload(unique('xlsx'), 'workbook timeout');
      await expect(pass(file.id)).rejects.toMatchObject({ fatalToExtract: true, code: 'timeout' });
      expect(namesOf(file.id)).toEqual([]);
      reply = grid();
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
      expect(await tablesOf(file.id)).toHaveLength(1);
    });

    it('a retryable too_large throws fatal; the retry builds', async () => {
      reply = failing('too_large', 413);
      const file = await upload(unique('xlsx'), 'workbook too large');
      await expect(pass(file.id)).rejects.toMatchObject({ fatalToExtract: true });
      expect(namesOf(file.id)).toEqual([]);
      reply = grid();
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
    });

    it("a second timeout is the file's for good: unreadable", async () => {
      reply = failing('timeout', 504);
      const file = await upload(unique('xlsx'), 'workbook twice');
      await expect(pass(file.id)).rejects.toMatchObject({ fatalToExtract: true });
      await pass(file.id);
      expect(await f.readFileDbNone(file.id, await shaOf(file.id))).toBe('unreadable');
    });

    it('bad_request throws fatal and writes no name', async () => {
      reply = failing('bad_request', 400);
      const file = await upload(unique('xlsx'), 'workbook bad request');
      await expect(pass(file.id)).rejects.toMatchObject({
        fatalToExtract: true,
        code: 'bad_request',
      });
      expect(namesOf(file.id)).toEqual([]);
    });

    it('a parser that is unavailable throws, and writes no name', async () => {
      reply = failing('unavailable', 503);
      const file = await upload(unique('xlsx'), 'workbook down');
      await expect(pass(file.id)).rejects.toMatchObject({ code: 'unavailable' });
      expect(namesOf(file.id)).toEqual([]);
    });

    it('a row with no valid sha256 makes no retry: the Table path, as today', async () => {
      const file = await upload(unique('xlsx'), 'workbook no sha');
      await x(sqlTag`update nodes set data = data - 'sha256' where id = ${file.id}`);
      reply = failing('timeout', 504);
      await expect(pass(file.id)).resolves.toBeUndefined();
      expect(parserCalls).toHaveLength(1);
      expect(namesOf(file.id)).toEqual([]);
      reply = grid();
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([]);
      expect(await tablesOf(file.id)).toHaveLength(1);
    });

    it('a row with no valid sha256, with the line: no read at all', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'workbook no sha line');
      await x(sqlTag`update nodes set data = data - 'sha256' where id = ${file.id}`);
      await pass(file.id);
      expect(h.reads).toEqual([]);
      expect(parserCalls).toEqual([]);
    });
  });

  describe('an old file', () => {
    it('a title change makes no read and no parser call, with a Table', async () => {
      const file = await upload(unique('xlsx'), 'workbook title');
      await pass(file.id);
      await completed(file.id);
      // An old file: no name of its bytes, only its Table.
      await f.removeFileDbNames(file.id);
      h.reads.length = 0;
      parserCalls.length = 0;
      await x(sqlTag`update nodes set title = 'renamed',
        data = data || '{"index_work":"embed"}'::jsonb where id = ${file.id}`);
      await pass(file.id);
      expect(h.reads).toEqual([]);
      expect(parserCalls).toEqual([]);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('a title change with the line and no Table makes no parser call either', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'workbook title line');
      await completed(file.id);
      await pass(file.id);
      expect(h.reads).toEqual([]);
      expect(parserCalls).toEqual([]);
    });

    it('a parked or skipped row is not pending', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      for (const key of ['extract_skipped', 'extract_parked']) {
        const file = await upload(unique('xlsx'), `workbook ${key}`);
        await x(sqlTag`update nodes
          set data = data || jsonb_build_object(${key}::text, 'x') where id = ${file.id}`);
        await pass(file.id);
        expect(h.reads, key).toEqual([]);
      }
    });

    it('a flip back to full: the stamp says pending, with the marker kept', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'workbook flip back');
      await completed(file.id);
      await x(sqlTag`update nodes set data = data || '{"index_work":"extract"}'::jsonb
        where id = ${file.id}`);
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
    });
  });

  describe('a replace', () => {
    it('with no line builds the new database, and the Table stays', async () => {
      const name = unique('xlsx');
      const file = await upload(name, 'version one');
      await pass(file.id);
      await completed(file.id);
      const [table] = await tablesOf(file.id);
      const oldSha = await shaOf(file.id);
      const again = await upload(name, 'version two');
      expect(again.id).toBe(file.id);
      const newSha = await shaOf(file.id);
      expect(newSha).not.toBe(oldSha);
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(newSha)]);
      expect((await tablesOf(file.id)).map((t) => t.id)).toEqual([table!.id]);
    });

    it('bytes that changed under the row: no name, and the new extract builds', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const name = unique('xlsx');
      const file = await upload(name, 'the old bytes');
      const stale = await nodeRow(file.id);
      await upload(name, 'the new bytes');
      await maybeAutoTableSpreadsheet(stale, anchor);
      expect(namesOf(file.id)).toEqual([]);
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
    });

    it('during the parse: no name of the old bytes', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const name = unique('xlsx');
      const file = await upload(name, 'parsed while replaced');
      h.duringParser = async () => {
        await upload(name, 'replaced while parsed');
      };
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([]);
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
    });

    it("bytes on disk that are not the row's: no name, with the row unchanged", async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const name = unique('xlsx');
      const file = await upload(name, 'what the row names');
      writeFileSync(f.diskPathForFile(FOLDER, name)!, 'what the disk holds now');
      await pass(file.id);
      expect(parserCalls).toHaveLength(1);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('during the parse: nothing is written at all, not even for a moment', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      reply = grid([]);
      const name = unique('xlsx');
      const file = await upload(name, 'word while replaced');
      const wrote = vi.fn(async () => undefined);
      h.afterWord = wrote;
      h.duringParser = async () => {
        await upload(name, 'replaced before the word');
      };
      await pass(file.id);
      expect(wrote).not.toHaveBeenCalled();
    });

    it('during the write: the old name goes, and the new one stays', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const name = unique('csv');
      const file = await upload(name, 'tag,size\n"P-101,50\n');
      h.afterWord = async () => {
        await upload(name, 'tag,size\nP-101,50\n');
        await f.writeFileDbNone(file.id, await shaOf(file.id), 'no-rows');
      };
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([noneName(await shaOf(file.id))]);
    });

    it('older names of the file go once a new one lands', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'older names');
      mkdirSync(f.fileDbsDir(), { recursive: true });
      writeFileSync(path.join(f.fileDbsDir(), `${file.id}.0123456789abcdef.sqlite`), 'old');
      writeFileSync(path.join(f.fileDbsDir(), `${file.id}.fedcba9876543210.none`), 'no-rows');
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
    });
  });

  describe('a private flip', () => {
    const makePrivate = (id: string) =>
      x(sqlTag`update nodes set data = data || '{"indexing":"metadata"}'::jsonb where id = ${id}`);

    it('during the parse: nothing readable', async () => {
      const file = await upload(unique('xlsx'), 'private while parsed');
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      h.duringParser = () => makePrivate(file.id).then(() => undefined);
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('during the parse, on a box with no line: no database and no Table', async () => {
      const file = await upload(unique('xlsx'), 'private while parsed, no line');
      h.duringParser = () => makePrivate(file.id).then(() => undefined);
      await pass(file.id);
      expect(parserCalls).toHaveLength(1);
      expect(namesOf(file.id)).toEqual([]);
      expect(await tablesOf(file.id)).toEqual([]);
    });

    it('during the parse: nothing is written at all, not even for a moment', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      reply = grid([]);
      const file = await upload(unique('xlsx'), 'private before the word');
      const wrote = vi.fn(async () => undefined);
      h.afterWord = wrote;
      h.duringParser = () => makePrivate(file.id).then(() => undefined);
      await pass(file.id);
      expect(wrote).not.toHaveBeenCalled();
    });

    it('during the write: every name goes', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('csv'), 'tag,size\n"P-101,50\n');
      h.afterWord = () => makePrivate(file.id).then(() => undefined);
      await pass(file.id);
      expect(namesOf(file.id)).toEqual([]);
    });

    it("a folder flag counts the same as the file's own", async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'in a flagged folder');
      h.duringParser = async () => {
        await x(sqlTag`update nodes set data = data || '{"indexing":"metadata"}'::jsonb
          where owner_id = ${anchor} and type = 'branch' and path = ${FOLDER}::ltree`);
      };
      try {
        await pass(file.id);
        expect(namesOf(file.id)).toEqual([]);
      } finally {
        await x(sqlTag`update nodes set data = data - 'indexing'
          where owner_id = ${anchor} and type = 'branch' and path = ${FOLDER}::ltree`);
      }
    });

    it('a row deleted during the parse: no name', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'gone while parsed');
      h.duringParser = async () => {
        await m.withNodeDeleteHeads([file.id], (tx) =>
          tx.execute(sqlTag`delete from nodes where id = ${file.id}`),
        );
      };
      const row = await nodeRow(file.id);
      await maybeAutoTableSpreadsheet(row, anchor);
      expect(namesOf(file.id)).toEqual([]);
    });
  });

  describe('two isolated tries', () => {
    it('a failed database write is logged, and the Table still lands', async () => {
      const blocker = f.fileDbsDir();
      const aside = `${blocker}.aside`;
      const had = existsSync(blocker);
      if (had) (await import('node:fs')).renameSync(blocker, aside);
      writeFileSync(blocker, 'a file where the folder goes');
      const seen = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const file = await upload(unique('xlsx'), 'database write fails');
        await pass(file.id);
        expect(await tablesOf(file.id)).toHaveLength(1);
        expect(seen.mock.calls.flat().join(' ')).toContain('file database failed');
      } finally {
        seen.mockRestore();
        rmSync(blocker, { force: true });
        if (had) (await import('node:fs')).renameSync(aside, blocker);
      }
    });

    it('a failed Table still leaves the database, and throws to the caller', async () => {
      const dead = randomUUID();
      await su(sqlTag`insert into workspaces (id, owner_id, name)
        values (${dead}, ${anchor}, ${`dead ${dead.slice(0, 8)}`})`);
      const folder = `files.dead_${dead.slice(0, 8)}`;
      await folderIn(dead, folder);
      const file = await upload(unique('xlsx'), 'table fails', dead, folder);
      await su(sqlTag`update workspaces set archived_at = now() where id = ${dead}`);
      // An archived home gives the part no live home: the Table's failure,
      // thrown as today, after the database has landed.
      await expect(pass(file.id)).rejects.toThrow(/live home/);
      expect(namesOf(file.id)).toEqual([sqliteName(await shaOf(file.id))]);
      expect(await tablesOf(file.id)).toEqual([]);
    });
  });

  describe('a delete', () => {
    it('by id removes the names', async () => {
      const file = await upload(unique('xlsx'), 'deleted by id');
      await pass(file.id);
      expect(namesOf(file.id)).toHaveLength(1);
      const res = await f.deleteFileById({ ownerId: anchor, fileId: file.id, deleteDerived: true });
      expect(res.ok).toBe(true);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('by path removes the names', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const name = unique('csv');
      const file = await upload(name, 'tag,size\n"P-101,50\n');
      await pass(file.id);
      expect(namesOf(file.id)).toHaveLength(1);
      const res = await f.deleteFileByPath({
        ownerId: anchor,
        parentPath: FOLDER,
        filename: name,
      });
      expect(res.ok).toBe(true);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('inside an outer transaction the names wait for its commit', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(unique('xlsx'), 'deleted in a transaction');
      await pass(file.id);
      await expect(
        m.withSystemTx(async () => {
          const res = await f.deleteFileById({ ownerId: anchor, fileId: file.id });
          expect(res.ok).toBe(true);
          expect(namesOf(file.id)).toHaveLength(1);
          throw new Error('the caller failed');
        }),
      ).rejects.toThrow('the caller failed');
      // Rolled back: the row is there, and so are its names.
      expect((await nodeRow(file.id)).id).toBe(file.id);
      expect(namesOf(file.id)).toHaveLength(1);

      await m.withSystemTx(async () => {
        expect((await f.deleteFileById({ ownerId: anchor, fileId: file.id })).ok).toBe(true);
        expect(namesOf(file.id)).toHaveLength(1);
      });
      expect(namesOf(file.id)).toEqual([]);
    });

    it('a refused delete keeps them', async () => {
      const file = await upload(unique('xlsx'), 'keeps its table');
      await pass(file.id);
      const res = await f.deleteFileById({ ownerId: anchor, fileId: file.id });
      expect(res).toMatchObject({ ok: false, reason: 'has_derived' });
      expect(namesOf(file.id)).toHaveLength(1);
    });
  });
});
