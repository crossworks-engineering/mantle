/**
 * The rebuild's database mode, `--orphans`, `--count`, and the file database
 * lines on the integrity screen, on a real migrated Postgres and a real files
 * root. The parser is faked at the fetch and counted, the object store and the
 * CAD pass are stand-ins. No model is reached, and a Table is touched only by the
 * table mode, asked for by name.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/maintenance/dwg-reindex-database.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import { contentKey } from '@mantle/storage';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  /** The object store, by key. */
  store: new Map<string, Buffer>(),
  commits: 0,
  /** The real CAD pass through the parser, not the stand-in. */
  realCad: false,
}));

vi.mock('@mantle/storage', async (orig) => ({
  ...(await orig<typeof import('@mantle/storage')>()),
  getContent: vi.fn(async (key: string) => {
    const body = h.store.get(key);
    if (!body) throw new Error('no such object');
    return { body: Readable.from([body]), contentLength: body.length };
  }),
}));
vi.mock('@mantle/files/dwg', async (orig) => {
  const actual = await orig<typeof import('@mantle/files/dwg')>();
  return {
    ...actual,
    cadRegistryWorkbook: async (...args: Parameters<typeof actual.cadRegistryWorkbook>) =>
      h.realCad
        ? actual.cadRegistryWorkbook(...args)
        : {
            grids: {
              sheets: [
                {
                  name: 'Layers',
                  columns: [{ name: 'Layer', type: 'text' }],
                  rows: [['C-90001 layer']],
                },
              ],
              capped: false,
            },
            description: 'AutoCAD DWG model-space registry. Segments holds every line (rebuilt).',
          },
  };
});
vi.mock('@mantle/content', async (orig) => {
  const actual = await orig<typeof import('@mantle/content')>();
  return {
    ...actual,
    commitTable: (...args: Parameters<typeof actual.commitTable>) => {
      h.commits += 1;
      return actual.commitTable(...args);
    },
  };
});

type Reply = () => Response;
const SECRET = 'P-101-CELL';
const SHEET = {
  name: 'LinesTabName',
  columns: [
    { name: 'Tag', type: 'text' },
    { name: 'Size', type: 'number' },
  ],
  rows: [
    [SECRET, 50],
    ['P-102-CELL', 80],
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
const PLAN = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks></Tasks></Project>';

describe.skipIf(!URL)('dwg-reindex, database mode', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('@mantle/files');
  let m: Db;
  let f: Files;
  let c: typeof import('@mantle/content');
  let r: typeof import('./dwg-reindex');
  let probe: typeof import('../integrity/file-dbs-check').fileDatabaseChecks;
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.m4';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-m4-'));
  let reply: Reply = grid();
  const parserCalls: string[] = [];

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const unique = (ext: string) => `${randomUUID().slice(0, 8)}.${ext}`;
  const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

  const upload = (name: string, bytes: string | Buffer) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: FOLDER,
        filename: name,
        bytes: Buffer.from(bytes),
      }),
    );
  /** A run of the task, as its script runs it. */
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await r.runDwgReindex(argv, (line) => lines.push(line));
    return { code, lines, text: lines.join('\n') };
  };
  const scoped = (...ids: string[]) => `--file=${ids.join(',')}`;
  const namesOf = (id: string) =>
    existsSync(f.fileDbsDir())
      ? readdirSync(f.fileDbsDir())
          .filter((n) => n.startsWith(id))
          .map((n) => n.slice(id.length + 1))
          .sort()
      : [];
  const sqlite = (bytes: string | Buffer) => `${sha256(bytes).slice(0, 16)}.sqlite`;
  const none = (bytes: string | Buffer) => `${sha256(bytes).slice(0, 16)}.none`;
  const setData = (id: string, patch: Record<string, unknown>) =>
    x(sqlTag`update nodes set data = data || ${JSON.stringify(patch)}::jsonb where id = ${id}`);

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    c = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    r = await import('./dwg-reindex');
    probe = (await import('../integrity/file-dbs-check')).fileDatabaseChecks;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    await su(sqlTag`insert into workspaces (id, owner_id, name)
      values (${team}, ${anchor}, ${`team ${team.slice(0, 8)}`})`);
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: FOLDER }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${randomUUID()}, ${anchor}, 'branch', ${FOLDER}, ${FOLDER}::ltree)`),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    reply = grid();
    parserCalls.length = 0;
    h.store.clear();
    h.commits = 0;
    h.realCad = false;
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        parserCalls.push(String(url));
        return reply();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('a run', () => {
    it('a dry run reads nothing and writes nothing', async () => {
      const bytes = 'workbook dry';
      const file = await upload(unique('xlsx'), bytes);
      const { code, text } = await run(scoped(file.id));
      expect(code).toBe(0);
      expect(text).toContain(`${file.id}: would read`);
      expect(parserCalls).toEqual([]);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('builds what has no name, and leaves what has one: a second run asks nothing', async () => {
      const bytes = 'workbook one';
      const file = await upload(unique('xlsx'), bytes);
      const first = await run(scoped(file.id), '--apply');
      expect(first.code).toBe(0);
      expect(first.text).toContain(`${file.id}: built (1 tabs, 2 rows)`);
      expect(namesOf(file.id)).toEqual([sqlite(bytes)]);
      expect(parserCalls).toHaveLength(1);
      const again = await run(scoped(file.id), '--again', '--apply');
      expect(again.text).toContain('1 already built');
      expect(parserCalls).toHaveLength(1);
    });

    it('prints no cell, tab name or file name', async () => {
      const name = unique('xlsx');
      const file = await upload(name, 'workbook words');
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain('built');
      for (const word of [SECRET, 'LinesTabName', name]) expect(text).not.toContain(word);
    });

    it('--after passes a skipped file, which cannot use up the cap', async () => {
      const made = [await upload(unique('xlsx'), 'kept a'), await upload(unique('xlsx'), 'kept b')];
      const [a, b] = [...made].sort((p, q) => (p.id < q.id ? -1 : 1));
      rmSync(f.diskPathForFile(a!.parentPath, a!.filename)!);

      const first = await run(scoped(a!.id, b!.id), '--limit=1', '--apply');
      expect(first.text).toContain(`${a!.id}: skipped: bytes-gone`);
      expect(first.text).toContain(`--after=${a!.id}`);
      expect(namesOf(b!.id)).toEqual([]);
      // Run again with no --after, and the skipped file takes the cap again.
      expect((await run(scoped(a!.id, b!.id), '--limit=1', '--apply')).text).toContain('--after=');
      expect(namesOf(b!.id)).toEqual([]);

      const next = await run(scoped(a!.id, b!.id), `--after=${a!.id}`, '--limit=1', '--apply');
      expect(next.text).toContain(`${b!.id}: built`);
      expect(namesOf(b!.id)).toHaveLength(1);
      expect(namesOf(a!.id)).toEqual([]);
    });

    it('names the id before it reads, so a file that kills the run is in the log', async () => {
      const file = await upload(unique('xlsx'), 'names first');
      const { lines } = await run(scoped(file.id), '--apply');
      const reading = lines.findIndex((l) => l.includes(`${file.id}: reading`));
      const built = lines.findIndex((l) => l.includes(`${file.id}: built`));
      expect(reading).toBeGreaterThanOrEqual(0);
      expect(built).toBeGreaterThan(reading);
    });

    it('a word is healed by --again, and left alone without it', async () => {
      const bytes = 'workbook word';
      const file = await upload(unique('xlsx'), bytes);
      reply = failing('failed', 422);
      await run(scoped(file.id), '--apply');
      expect(namesOf(file.id)).toEqual([none(bytes)]);

      parserCalls.length = 0;
      reply = grid();
      const plain = await run(scoped(file.id), '--apply');
      expect(plain.text).toContain('1 already have a word');
      expect(parserCalls).toEqual([]);

      const healed = await run(scoped(file.id), '--again', '--apply');
      expect(healed.text).toContain(`${file.id}: built`);
      expect(namesOf(file.id)).toEqual([sqlite(bytes)]);
    });

    it('builds a plan XML, and a non-plan XML gets no name and counts as a skip', async () => {
      const plan = await upload(unique('xml'), PLAN);
      const other = await upload(unique('xml'), '<Invoice></Invoice>');
      reply = grid([SHEET], { taskCount: 2, summaryCount: 0 });
      const { text } = await run(scoped(plan.id, other.id), '--apply');
      expect(text).toContain(`${plan.id}: built`);
      expect(namesOf(plan.id)).toEqual([sqlite(PLAN)]);
      expect(text).toContain(`${other.id}: skipped: not-plan`);
      expect(namesOf(other.id)).toEqual([]);
      expect(parserCalls).toHaveLength(1);
    });

    it('an XML with a Project root that fails the full sniff: no-rows', async () => {
      const bytes = '<Project><Name>x</Name></Project>';
      const file = await upload(unique('xml'), bytes);
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: word: no-rows`);
      expect(namesOf(file.id)).toEqual([none(bytes)]);
      expect(parserCalls).toEqual([]);
    });

    it('a drive-synced file heals through the object store', async () => {
      const name = unique('xlsx');
      const bytes = 'workbook from a drive';
      const file = await upload(name, bytes);
      await x(sqlTag`update nodes set data = data - 'filename', title = ${name}
        where id = ${file.id}`);
      rmSync(f.diskPathForFile(file.parentPath, name)!);

      const gone = await run(scoped(file.id), '--apply');
      expect(gone.text).toContain('skipped: bytes-gone');

      h.store.set(contentKey(sha256(bytes)), Buffer.from(bytes));
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: built`);
      expect(namesOf(file.id)).toEqual([sqlite(bytes)]);
    });

    it('a private file is skipped and gets no name, by its own flag or its folder', async () => {
      const own = await upload(unique('xlsx'), 'private by flag');
      await setData(own.id, { indexing: 'metadata' });
      const inside = await upload(unique('xlsx'), 'private by folder');
      await x(sqlTag`update nodes set data = data || '{"indexing":"metadata"}'::jsonb
        where owner_id = ${anchor} and type = 'branch' and path = ${FOLDER}::ltree`);
      try {
        const { text } = await run(scoped(own.id, inside.id), '--apply');
        expect(text).toContain(`${own.id}: skipped: private`);
        expect(text).toContain(`${inside.id}: skipped: private`);
        expect(parserCalls).toEqual([]);
        expect(namesOf(own.id)).toEqual([]);
        expect(namesOf(inside.id)).toEqual([]);
      } finally {
        await x(sqlTag`update nodes set data = data - 'indexing'
          where owner_id = ${anchor} and type = 'branch' and path = ${FOLDER}::ltree`);
      }
    });

    it('a quiet copy, or an id that is no such file: not a candidate', async () => {
      const copy = await upload(unique('xlsx'), 'a quiet copy');
      await setData(copy.id, { snapshot_of: randomUUID() });
      const absent = randomUUID();
      const { text } = await run(scoped(copy.id, absent), '--apply');
      expect(text).toContain(`${copy.id}: skipped: not-a-candidate`);
      expect(text).toContain(`${absent}: skipped: not-a-candidate`);
      expect(namesOf(copy.id)).toEqual([]);
    });

    it('bytes that are not the row: nothing written, nothing asked, and a count', async () => {
      const file = await upload(unique('xlsx'), 'workbook row bytes');
      writeFileSync(f.diskPathForFile(file.parentPath, file.filename)!, 'other bytes on disk');
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: skipped: sha-differs`);
      expect(text).toContain('1 skipped sha-differs');
      expect(parserCalls).toEqual([]);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('a row with no valid sha256: a skip, and no read', async () => {
      const file = await upload(unique('xlsx'), 'workbook no sha');
      await x(sqlTag`update nodes set data = data - 'sha256' where id = ${file.id}`);
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: skipped: no-sha`);
      expect(parserCalls).toEqual([]);
    });
  });

  describe('a parser failure', () => {
    it('a code that counts is retried once in the run: the second earns its word', async () => {
      for (const [code, status, word] of [
        ['timeout', 504, 'unreadable'],
        ['crashed', 500, 'unreadable'],
        ['too_large', 413, 'too-large'],
      ] as const) {
        const bytes = `workbook twice ${code}`;
        const file = await upload(unique('xlsx'), bytes);
        parserCalls.length = 0;
        reply = failing(code, status);
        const { text } = await run(scoped(file.id), '--apply');
        expect(parserCalls, code).toHaveLength(2);
        expect(text, code).toContain(`${file.id}: word: ${word}`);
        expect(namesOf(file.id), code).toEqual([none(bytes)]);
      }
    });

    it('a retry that reads builds it', async () => {
      const bytes = 'workbook second try';
      const file = await upload(unique('xlsx'), bytes);
      const replies = [failing('timeout', 504), grid()];
      reply = () => replies.shift()!();
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: built`);
      expect(parserCalls).toHaveLength(2);
    });

    it('a drawing goes round too: its failed read is no memo in this run', async () => {
      h.realCad = true;
      const bytes = `AC1032 ${randomUUID()}`;
      const file = await upload(unique('dwg'), bytes);
      reply = failing('timeout', 504);
      const { text } = await run(scoped(file.id), '--apply');
      expect(parserCalls).toHaveLength(2);
      expect(text).toContain(`${file.id}: word: unreadable`);
      expect(namesOf(file.id)).toEqual([none(bytes)]);
    });

    it('unavailable writes nothing and counts, with no retry', async () => {
      const file = await upload(unique('xlsx'), 'workbook parser down');
      reply = failing('unavailable', 503);
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: nothing written: parser unavailable`);
      expect(text).toContain('1 parser unavailable');
      expect(parserCalls).toHaveLength(1);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('busy writes nothing and counts, after its own waits', async () => {
      const file = await upload(unique('xlsx'), 'workbook parser busy');
      reply = failing('busy', 429);
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: nothing written: parser busy`);
      expect(namesOf(file.id)).toEqual([]);
    }, 40_000);

    it('bad_request is no verdict: nothing written', async () => {
      const file = await upload(unique('xlsx'), 'workbook roll mismatch');
      reply = failing('bad_request', 400);
      const { text } = await run(scoped(file.id), '--apply');
      expect(text).toContain(`${file.id}: nothing written: parser bad_request`);
      expect(namesOf(file.id)).toEqual([]);
    });

    it('an error from the disk writes nothing and prints its code alone', async () => {
      const file = await upload(unique('xlsx'), 'workbook on a bad disk');
      const dir = f.fileDbsDir();
      // A folder, not empty, where the word goes.
      const blocked = f.fileDbPaths(file.id, sha256('workbook on a bad disk'))!.none;
      mkdirSync(path.join(blocked, 'in-the-way'), { recursive: true });
      reply = failing('failed', 422);
      try {
        const { text } = await run(scoped(file.id), '--apply');
        expect(text).toContain(`${file.id}: nothing written: failed`);
        expect(text).not.toContain(dir);
      } finally {
        rmSync(blocked, { recursive: true, force: true });
      }
    });

    it('a folder this process cannot write: nothing read, and it says which flag', async () => {
      const file = await upload(unique('xlsx'), 'workbook on a read-only mount');
      mkdirSync(f.fileDbsDir(), { recursive: true });
      chmodSync(f.fileDbsDir(), 0o555);
      try {
        const build = await run(scoped(file.id), '--apply');
        expect(build.code).toBe(1);
        expect(build.text).toContain('--files-writable');
        expect((await run('--orphans', '--apply')).code).toBe(1);
        expect(parserCalls).toEqual([]);
      } finally {
        chmodSync(f.fileDbsDir(), 0o755);
      }
    });
  });

  describe('--orphans', () => {
    const touch = (name: string, ageMs = 0) => {
      mkdirSync(f.fileDbsDir(), { recursive: true });
      const abs = path.join(f.fileDbsDir(), name);
      writeFileSync(abs, 'x');
      if (ageMs) {
        const then = new Date(Date.now() - ageMs);
        utimesSync(abs, then, then);
      }
    };
    const HOUR = 60 * 60 * 1000;

    it('refuses --file, --folder and --after: it would remove every orphan on the box', async () => {
      const gone = `${randomUUID()}.0123456789abcdef.sqlite`;
      touch(gone);
      const id = randomUUID();
      for (const narrow of [`--file=${id}`, `--folder=${id}`, `--after=${id}`]) {
        const { code, text } = await run('--orphans', narrow, '--apply');
        expect(code, narrow).toBe(2);
        expect(text).toContain('Nothing done');
        expect(existsSync(path.join(f.fileDbsDir(), gone)), narrow).toBe(true);
      }
      rmSync(path.join(f.fileDbsDir(), gone));
    });

    it('lists without removing, and removes only with --apply', async () => {
      const bytes = 'workbook orphans';
      const live = await upload(unique('xlsx'), bytes);
      await run(scoped(live.id), '--apply');
      const hidden = await upload(unique('xlsx'), 'workbook hidden');
      await run(scoped(hidden.id), '--apply');
      await setData(hidden.id, { indexing: 'metadata' });

      const gone = `${randomUUID()}.0123456789abcdef.sqlite`;
      const goneWord = `${randomUUID()}.0123456789abcdef.none`;
      const older = `${live.id}.0123456789abcdef.sqlite`;
      const oldBuild = `${randomUUID()}.0123456789abcdef.sqlite.build-1-aaaaaaaa`;
      const youngBuild = `${randomUUID()}.0123456789abcdef.sqlite.build-1-bbbbbbbb`;
      const foreign = 'not-ours.txt';
      touch(gone);
      touch(goneWord);
      touch(older);
      touch(oldBuild, 2 * HOUR);
      touch(youngBuild, HOUR - 60_000);
      touch(foreign);

      const listed = await run('--orphans');
      expect(listed.code).toBe(0);
      expect(listed.text).toContain(`${gone}: no-row`);
      expect(listed.text).toContain(`${goneWord}: no-row`);
      expect(listed.text).toContain(`${older}: sha-differs`);
      expect(listed.text).toContain(`${hidden.id}.`);
      expect(listed.text).toMatch(new RegExp(`${hidden.id}\\.[0-9a-f]{16}\\.sqlite: private`));
      expect(listed.text).toContain(`${oldBuild}: old-build`);
      expect(listed.text).not.toContain(youngBuild);
      expect(listed.text).not.toContain(`${live.id}.${sqlite(bytes)}`);
      expect(listed.text).toContain('DRY RUN');
      // Nothing moved.
      for (const name of [gone, goneWord, older, oldBuild, youngBuild, foreign]) {
        expect(existsSync(path.join(f.fileDbsDir(), name)), name).toBe(true);
      }
      expect(namesOf(hidden.id)).toHaveLength(1);

      const applied = await run('--orphans', '--apply');
      expect(applied.code).toBe(0);
      for (const name of [gone, goneWord, older, oldBuild]) {
        expect(existsSync(path.join(f.fileDbsDir(), name)), name).toBe(false);
      }
      expect(namesOf(hidden.id)).toEqual([]);
      // The good name, a young write, and what is no name of this folder's stay.
      expect(namesOf(live.id)).toEqual([sqlite(bytes)]);
      expect(existsSync(path.join(f.fileDbsDir(), youngBuild))).toBe(true);
      expect(existsSync(path.join(f.fileDbsDir(), foreign))).toBe(true);
      rmSync(path.join(f.fileDbsDir(), youngBuild));
      rmSync(path.join(f.fileDbsDir(), foreign));
    });
  });

  describe('--count', () => {
    const tabOf = (name: string, rows: unknown[][]) => ({
      ...c.tableDocFromGrid({
        columns: [{ name: 'Tag', type: 'text' }],
        rows: rows as never,
      }),
      name,
    });
    /** A file with an old auto-import Table of these tabs. */
    const withTable = async (bytes: string, tabs: ReturnType<typeof tabOf>[]) => {
      const file = await upload(unique('xlsx'), bytes);
      await m.createPartOfFile(
        file.id,
        () =>
          c.createTable(anchor, {
            title: `t ${file.id.slice(0, 8)}`,
            tags: ['auto-import'],
            sourceFileId: file.id,
            tabs,
          }),
        (t) => c.deleteTable(anchor, t.id),
      );
      return file;
    };
    const sheetOf = (name: string, rows: number) => ({
      name,
      columns: [{ name: 'Tag', type: 'text' }],
      rows: Array.from({ length: rows }, (_, i) => [`${SECRET}-${i}`]),
    });

    it('passes when every old tab matches, printing no cell text', async () => {
      const file = await withTable('count match', [
        tabOf('MatchTabName', [[SECRET], ['b'], ['c']]),
      ]);
      reply = grid([sheetOf('MatchTabName', 3)]);
      await run(scoped(file.id), '--apply');
      const { code, text } = await run('--count', scoped(file.id));
      expect(code).toBe(0);
      expect(text).toMatch(/PASS/);
      for (const word of [SECRET, 'MatchTabName']) expect(text).not.toContain(word);
    });

    it('fails on a difference, by position and numbers, with exit code 1', async () => {
      const file = await withTable('count differs', [
        tabOf('DifferTabName', [[SECRET], ['b'], ['c']]),
      ]);
      reply = grid([sheetOf('DifferTabName', 2)]);
      await run(scoped(file.id), '--apply');
      const { code, text } = await run('--count', scoped(file.id));
      expect(code).toBe(1);
      expect(text).toContain(`${file.id}: tab 1: old 3, database 2`);
      expect(text).toMatch(/FAIL/);
      for (const word of [SECRET, 'DifferTabName']) expect(text).not.toContain(word);
    });

    it('fails on an old tab the database lacks, and on a file with no database', async () => {
      const lacks = await withTable('count lacks', [tabOf('A', [['1']]), tabOf('B', [['2']])]);
      reply = grid([sheetOf('A', 1)]);
      await run(scoped(lacks.id), '--apply');
      const first = await run('--count', scoped(lacks.id));
      expect(first.code).toBe(1);
      expect(first.text).toContain('tab 2: old 1, no such tab');

      const unbuilt = await withTable('count unbuilt', [tabOf('A', [['1']])]);
      const second = await run('--count', scoped(unbuilt.id));
      expect(second.code).toBe(1);
      expect(second.text).toContain(`${unbuilt.id}: no database`);
    });

    it('leaves the old Checks tab out, and only lists extra tabs', async () => {
      const file = await withTable('count checks', [
        tabOf('A', [['1']]),
        tabOf('Checks', [['x'], ['y']]),
      ]);
      reply = grid([sheetOf('A', 1), sheetOf('Past the Table cap', 4)]);
      await run(scoped(file.id), '--apply');
      const { code, text } = await run('--count', scoped(file.id));
      expect(code).toBe(0);
      expect(text).toContain(`${file.id}: 1 extra tabs in the database`);
      expect(text).toMatch(/PASS/);
      expect(text).not.toContain('Past the Table cap');
    });

    it('a private file with an old Table is counted as private, not as a difference', async () => {
      const file = await withTable('count private', [tabOf('A', [['1']])]);
      await setData(file.id, { indexing: 'metadata' });
      const { code, text } = await run('--count', scoped(file.id));
      expect(code).toBe(0);
      expect(text).toContain('1 private');
      expect(text).toMatch(/PASS/);
      expect(text).not.toContain('no database');
    });

    it('a file with a database and no old Table is nothing to compare', async () => {
      const file = await upload(unique('xlsx'), 'count no table');
      await run(scoped(file.id), '--apply');
      const { code, text } = await run('--count', scoped(file.id));
      expect(code).toBe(0);
      expect(text).toContain('nothing');
    });
  });

  describe('the table mode, only ever by name', () => {
    const CLAIM = 'AutoCAD DWG registry. Vector geometry beyond text is not in this table.';
    const drawing = async () => {
      const file = await upload(unique('dwg'), `AC1032 ${randomUUID()}`);
      const table = await m.createPartOfFile(
        file.id,
        () =>
          c.createTable(anchor, {
            title: `drawing ${file.id.slice(0, 8)}`,
            tags: ['auto-import'],
            sourceFileId: file.id,
            description: CLAIM,
            tabs: [
              {
                ...c.tableDocFromGrid({
                  columns: [{ name: 'Layer', type: 'text' }],
                  rows: [['old']],
                }),
                name: 'Layers',
              },
            ],
          }),
        (t) => c.deleteTable(anchor, t.id),
      );
      return { file, table };
    };
    const versionOf = async (id: string) =>
      (await x<{ v: number }>(sqlTag`select version as v from tables where node_id = ${id}`))[0]!.v;

    it('the default builds the database and never reaches a Table or a summary', async () => {
      const { file, table } = await drawing();
      const before = await versionOf(table.id);
      const { code, text } = await run(scoped(file.id), '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${file.id}: built`);
      expect(text).not.toContain('summary');
      expect(h.commits).toBe(0);
      expect(await versionOf(table.id)).toBe(before);
      const [row] = await x<{ d: string }>(
        sqlTag`select data->>'description' as d from nodes where id = ${table.id}`,
      );
      expect(row!.d).toBe(CLAIM);
    });

    it('a table flag with no --table is refused', async () => {
      for (const flag of ['--keep-edits', '--resummarize', '--may-spend']) {
        const { code, text } = await run('--apply', flag);
        expect(code, flag).toBe(2);
        expect(text).toContain('--table');
      }
      expect(h.commits).toBe(0);
    });

    it('--table is still reached by name, and a live run needs --may-spend', async () => {
      const { file, table } = await drawing();
      const dry = await run('--table', scoped(file.id));
      expect(dry.code).toBe(0);
      expect(dry.text).toContain('summary');
      expect(h.commits).toBe(0);

      const refused = await run('--table', scoped(file.id), '--apply');
      expect(refused.code).toBe(2);
      expect(refused.text).toContain('--may-spend');
      expect(h.commits).toBe(0);

      const before = await versionOf(table.id);
      const live = await run('--table', scoped(file.id), '--apply', '--may-spend');
      expect(live.code).toBe(0);
      expect(live.text).toContain('summary rewritten');
      expect(h.commits).toBe(1);
      expect(await versionOf(table.id)).toBeGreaterThan(before);
    });

    it('--table keeps its own scope rule: never the whole box', async () => {
      expect((await run('--table')).code).toBe(2);
    });
  });

  describe('the integrity screen', () => {
    const counts = async () => {
      const list = await probe(anchor);
      return {
        list,
        n: Object.fromEntries(list.map((k) => [k.key, k.count])) as Record<string, number>,
      };
    };
    const app = async (slugs: string[]) => {
      const id = randomUUID();
      await x(sqlTag`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${anchor}, 'app', ${`app ${id.slice(0, 8)}`}, 'apps')`);
      await x(sqlTag`insert into apps (node_id, manifest)
        values (${id}, ${JSON.stringify({ toolSlugs: slugs })}::jsonb)`);
      return id;
    };

    it('counts table-type files with no name, leaving out the private, a quiet copy and XML', async () => {
      const before = (await counts()).n.file_db_missing!;
      const plain = await upload(unique('xlsx'), 'probe plain');
      await upload(unique('xml'), 'probe xml');
      const own = await upload(unique('csv'), 'probe own flag');
      await setData(own.id, { indexing: 'metadata' });
      const copy = await upload(unique('xlsx'), 'probe copy');
      await setData(copy.id, { snapshot_of: randomUUID() });
      await upload(unique('txt'), 'probe not a table type');
      const after = await counts();
      expect(after.n.file_db_missing).toBe(before + 1);
      const check = after.list.find((k) => k.key === 'file_db_missing')!;
      expect(check.ok).toBe(false);
      // A build takes it off the count.
      await run(scoped(plain.id), '--apply');
      expect((await counts()).n.file_db_missing).toBe(before);
    });

    it('counts a folder flag as private, by the same rule', async () => {
      await upload(unique('xlsx'), 'probe in a folder');
      const before = (await counts()).n.file_db_missing!;
      await x(sqlTag`update nodes set data = data || '{"indexing":"metadata"}'::jsonb
        where owner_id = ${anchor} and type = 'branch' and path = ${FOLDER}::ltree`);
      try {
        expect((await counts()).n.file_db_missing).toBeLessThan(before);
      } finally {
        await x(sqlTag`update nodes set data = data - 'indexing'
          where owner_id = ${anchor} and type = 'branch' and path = ${FOLDER}::ltree`);
      }
    });

    it('counts words by word, and an XML word as well', async () => {
      const before = (await counts()).n;
      reply = failing('too_large', 413, true);
      const large = await upload(unique('xlsx'), 'probe too large');
      await run(scoped(large.id), '--apply');
      reply = failing('failed', 422);
      const bad = await upload(unique('xlsx'), 'probe unreadable');
      await run(scoped(bad.id), '--apply');
      const hollow = await upload(unique('xml'), '<Project><Name>probe</Name></Project>');
      await run(scoped(hollow.id), '--apply');
      const after = (await counts()).n;
      expect(after.file_db_word_too_large).toBe(before.file_db_word_too_large! + 1);
      expect(after.file_db_word_unreadable).toBe(before.file_db_word_unreadable! + 1);
      expect(after.file_db_word_no_rows).toBe(before.file_db_word_no_rows! + 1);
    });

    it('counts names with no live row, and their bytes in the label', async () => {
      const name = `${randomUUID()}.0123456789abcdef.sqlite`;
      const before = (await counts()).n.file_db_no_live_row!;
      mkdirSync(f.fileDbsDir(), { recursive: true });
      writeFileSync(path.join(f.fileDbsDir(), name), Buffer.alloc(1234));
      const { list, n } = await counts();
      expect(n.file_db_no_live_row).toBe(before + 1);
      expect(list.find((k) => k.key === 'file_db_no_live_row')!.label).toContain('1234 bytes');
      rmSync(path.join(f.fileDbsDir(), name));
    });

    it('counts live apps that hold any of the 34, by slug or by ref', async () => {
      const before = (await counts()).n.apps_holding_table_tools!;
      const direct = await app(['calculate', 'table_sql']);
      await app(['calculate', 'file_sql']);
      await x(sqlTag`insert into tools (owner_id, slug, name, description, handler, requires_confirm)
        values (${anchor}, 'm4_alias', 'n', 'd', '{"kind":"builtin","ref":"node_read"}'::jsonb, false)`);
      await app(['m4_alias']);
      const after = await counts();
      expect(after.n.apps_holding_table_tools).toBe(before + 2);
      // A deleted app has no row, and so no count.
      await x(sqlTag`delete from apps where node_id = ${direct}`);
      expect((await counts()).n.apps_holding_table_tools).toBe(before + 1);
    });

    it('says whether the line is on, at count 0, with its value in the label', async () => {
      const line = async () => (await counts()).list.find((k) => k.key === 'no_auto_tables_line')!;
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '');
      expect(await line()).toMatchObject({ count: 0, ok: true });
      expect((await line()).label).toMatch(/off \(value: not set\)/);
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      expect(await line()).toMatchObject({ count: 0, ok: true });
      expect((await line()).label).toMatch(/on \(value: 1\)/);
    });
  });
});
