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
  readFileSync,
  renameSync,
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
      expect(text).not.toContain(r.DGN_DRY_RUN);
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

  describe('--dgn-data: a DGN read before the data reader gets its data', () => {
    /** A DGN V8 head (a compound file that names the `Dgn~H` stream), then
     *  made-up bytes: the sniff takes it. */
    const v8Bytes = () =>
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.from(randomUUID()),
        Buffer.from('Dgn~H', 'utf16le'),
      ]);
    /** A DGN V7 2D head, then made-up bytes. */
    const v7Bytes = () =>
      Buffer.concat([Buffer.from([0x08, 0x09, 0xfe, 0x02]), Buffer.from(randomUUID())]);
    /** The CAD tier's `dgn` record, in the shapes it really sends: the data
     *  reader on a V8 file holds `shared_cells`; ezdgn 0.3.2 on a V8 file does
     *  not; a V7 2D file never does, whatever the reader; a V8 file whose data
     *  read failed was read the 0.3.2 way and says `data_error`. */
    const RECORDS = {
      data: { format: 'V8', dimension: 2, shared_cells: { expanded: 1 } },
      old: { format: 'V8', dimension: 2 },
      v7: { format: 'V7 2D', dimension: 2 },
      'data-error': { format: 'V8', dimension: 2, data_error: 'ValueError' },
    } as const;
    const dgnReply =
      (kind: keyof typeof RECORDS): Reply =>
      () =>
        Response.json({
          converter: 'ezdgn',
          layers: [{ name: 'Pipe', count: 1 }],
          texts: [{ text: 'NOTE 1', layer: 'Pipe', x: 1, y: 2 }],
          counts: { LINE: 1 },
          dgn: RECORDS[kind],
        });
    type Kind = keyof typeof RECORDS | 'fail' | 'not-dgn';
    /** One reply a parser call, in the run's order (id order). A file that is
     *  not a DGN gets no call. */
    const inTurn = (files: { kind: Kind }[]): Reply => {
      const left = files
        .filter((f) => f.kind !== 'not-dgn')
        .map((f) =>
          f.kind === 'fail' ? failing('timeout', 504) : dgnReply(f.kind as keyof typeof RECORDS),
        );
      return () => left.shift()!();
    };
    /** A database that is there already, from the old reader: its name only. */
    const oldDatabase = (id: string, bytes: Buffer) => {
      mkdirSync(f.fileDbsDir(), { recursive: true });
      const abs = path.join(f.fileDbsDir(), `${id}.${sqlite(bytes)}`);
      writeFileSync(abs, 'old database');
      return abs;
    };
    const isNew = (abs: string) =>
      readFileSync(abs).subarray(0, 15).toString() === 'SQLite format 3';
    /** Uploads, each with its old database, in id order (the run's). */
    const olds = async (...made: Buffer[]) =>
      kinds(...made.map((bytes) => ['data', bytes] as const));
    const kinds = async (...made: (readonly [Kind, Buffer])[]) => {
      const files = [];
      for (const [kind, bytes] of made) {
        const file = await upload(unique('dgn'), bytes);
        files.push({ kind, id: file.id, bytes, abs: oldDatabase(file.id, bytes) });
      }
      return files.sort((p, q) => (p.id < q.id ? -1 : 1));
    };
    const ofKind = <T extends { kind: Kind }>(files: T[], kind: Kind) =>
      files.find((f) => f.kind === kind)!;
    const parserOnly = () => {
      // Every request of the run went to the parser's drawing route: no model,
      // no other service.
      expect(parserCalls.length).toBeGreaterThan(0);
      for (const call of parserCalls)
        expect(call).toMatch(/^http:\/\/parser\.test:8095\/dwg\/render/);
    };

    beforeEach(() => {
      h.realCad = true;
    });

    it('a dry run lists DGN files only, with or without a name, and reads nothing', async () => {
      const built = v8Bytes();
      const dgn = await upload(unique('dgn'), built);
      oldDatabase(dgn.id, built);
      const fresh = await upload(unique('dgn'), v8Bytes());
      const sheet = await upload(unique('xlsx'), 'workbook beside a dgn');
      const { code, text } = await run(scoped(dgn.id, fresh.id, sheet.id), '--dgn-data');
      expect(code).toBe(0);
      expect(text).toContain(`${dgn.id}: would read${r.DGN_DRY_RUN}`);
      expect(text).toContain(`${fresh.id}: would read${r.DGN_DRY_RUN}`);
      expect(text).toContain(`${sheet.id}: skipped: not-a-candidate`);
      expect(parserCalls).toEqual([]);
    });

    it('builds a DGN that has its name again, over the same name, with the parser alone', async () => {
      const [file] = await olds(v8Bytes());
      reply = dgnReply('data');
      const { code, text } = await run(scoped(file!.id), '--dgn-data', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${file!.id}: built (`);
      expect(namesOf(file!.id)).toEqual([sqlite(file!.bytes)]);
      expect(isNew(file!.abs)).toBe(true);
      expect(parserCalls).toHaveLength(1); // the guard and the build share one exchange
      parserOnly();
      expect(h.commits).toBe(0); // no Table
    });

    it('writes nothing to the file row and adds no row or job anywhere', async () => {
      const [file] = await olds(v8Bytes());
      type Row = { data: unknown; updated_at: unknown; sha: string | null };
      const rowOf = async () =>
        (
          await x<Row>(sqlTag`select data, updated_at::text, data->>'sha256' as sha
            from nodes where id = ${file!.id}`)
        )[0];
      /** Rows the run could add: nodes, runs, and pg-boss jobs where the
       *  schema is there. */
      const tally = async () => {
        const [t] = await x<{ nodes: number; runs: number; boss: string | null }>(sqlTag`select
          (select count(*)::int from nodes) as nodes,
          (select count(*)::int from runs) as runs,
          to_regclass('pgboss.job')::text as boss`);
        const jobs = t!.boss
          ? (await x<{ n: number }>(sqlTag`select count(*)::int as n from pgboss.job`))[0]!.n
          : null;
        return { nodes: t!.nodes, runs: t!.runs, jobs };
      };
      const [row, before] = [await rowOf(), await tally()];
      reply = dgnReply('data');
      const { code, text } = await run(scoped(file!.id), '--dgn-data', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${file!.id}: built (`);
      expect(await rowOf()).toEqual(row);
      expect((await rowOf())!.sha).toBe(sha256(file!.bytes));
      expect(await tally()).toEqual(before);
    });

    it('without --dgn-data a DGN with its name is left alone', async () => {
      const [file] = await olds(v8Bytes());
      reply = dgnReply('data');
      const { text } = await run(scoped(file!.id), '--apply');
      expect(text).toContain('1 already built');
      expect(parserCalls).toEqual([]);
    });

    it('the old reader on a V8 file: the run stops there, writes nothing and says how to go past', async () => {
      const [first, second] = await olds(v8Bytes(), v8Bytes());
      reply = dgnReply('old');
      const { code, text } = await run(scoped(first!.id, second!.id), '--dgn-data', '--apply');
      expect(code).toBe(1);
      expect(text).toContain(
        `${first!.id}: nothing written: the parser reads DGN with the old reader`,
      );
      expect(text).toContain('STOPPED: 1 refused old-reader');
      expect(text).toContain(`run again with --after=${first!.id}`);
      expect(readFileSync(first!.abs).toString()).toBe('old database');
      expect(readFileSync(second!.abs).toString()).toBe('old database');
      expect(parserCalls).toHaveLength(1); // the second file is never read
      parserOnly();
    });

    it('a V7 file (the real reply: V7 2D, no shared_cells) is skipped, and the run goes on', async () => {
      const files = await kinds(['v7', v7Bytes()], ['data', v8Bytes()]);
      const [v7, v8] = [ofKind(files, 'v7'), ofKind(files, 'data')];
      reply = inTurn(files);
      const { code, text } = await run(scoped(v7.id, v8.id), '--dgn-data', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${v7.id}: skipped: v7`);
      expect(text).toContain(`${v8.id}: built (`);
      expect(text).not.toContain('STOPPED');
      expect(readFileSync(v7.abs).toString()).toBe('old database');
      expect(isNew(v8.abs)).toBe(true);
    });

    it('a .dgn name that holds DWG bytes is skipped with no parser call, and the run goes on', async () => {
      const files = await kinds(
        ['not-dgn', Buffer.from(`AC1032 ${randomUUID()}`)],
        ['data', v8Bytes()],
      );
      const [dwg, v8] = [ofKind(files, 'not-dgn'), ofKind(files, 'data')];
      reply = inTurn(files);
      const { code, text } = await run(scoped(dwg.id, v8.id), '--dgn-data', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${dwg.id}: skipped: not-dgn`);
      expect(text).toContain(`${v8.id}: built (`);
      expect(parserCalls).toHaveLength(1); // the DGN only
      expect(readFileSync(dwg.abs).toString()).toBe('old database');
    });

    it('a V8 file whose data read failed is skipped (the image is new), and the run goes on', async () => {
      const files = await kinds(['data-error', v8Bytes()], ['data', v8Bytes()]);
      const [bad, good] = [ofKind(files, 'data-error'), ofKind(files, 'data')];
      reply = inTurn(files);
      const { code, text } = await run(scoped(bad.id, good.id), '--dgn-data', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${bad.id}: skipped: data-error`);
      expect(text).toContain(`${good.id}: built (`);
      expect(readFileSync(bad.abs).toString()).toBe('old database');
    });

    it('a failed guard call leaves the old database, and the run goes on', async () => {
      const files = await kinds(['fail', v8Bytes()], ['data', v8Bytes()]);
      const [failed, good] = [ofKind(files, 'fail'), ofKind(files, 'data')];
      reply = inTurn(files);
      const { code, text } = await run(scoped(failed.id, good.id), '--dgn-data', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${failed.id}: nothing written: parser timeout`);
      expect(text).toContain(`${good.id}: built (`);
      expect(readFileSync(failed.abs).toString()).toBe('old database');
    });

    it('a private DGN is skipped and read never', async () => {
      const [file] = await olds(v8Bytes());
      await setData(file!.id, { indexing: 'metadata' });
      reply = dgnReply('data');
      const { text } = await run(scoped(file!.id), '--dgn-data', '--apply');
      expect(text).toContain(`${file!.id}: skipped: private`);
      expect(parserCalls).toEqual([]);
      expect(readFileSync(file!.abs).toString()).toBe('old database');
    });

    it('--limit cuts and --after goes on, and a stop on the last file read is a stop', async () => {
      const [a, b] = await olds(v8Bytes(), v8Bytes());
      reply = dgnReply('data');
      const first = await run(scoped(a!.id, b!.id), '--dgn-data', '--limit=1', '--apply');
      expect(first.code).toBe(0);
      expect(first.text).toContain(`${a!.id}: built (`);
      expect(first.text).toContain(`--after=${a!.id}`);
      expect(readFileSync(b!.abs).toString()).toBe('old database');
      // The cap and the stop on one file: the stop wins, and names the file.
      reply = dgnReply('old');
      const next = await run(
        scoped(a!.id, b!.id),
        '--dgn-data',
        `--after=${a!.id}`,
        '--limit=1',
        '--apply',
      );
      expect(next.code).toBe(1);
      expect(next.text).toContain('STOPPED: 1 refused old-reader');
      expect(next.text).toContain(`run again with --after=${b!.id}`);
      expect(next.text).not.toContain('cut at --limit');
      expect(readFileSync(b!.abs).toString()).toBe('old database');
    });

    it('is refused with --table, --orphans and --count, before anything is read', async () => {
      for (const other of ['--table', '--orphans', '--count']) {
        const { code, text } = await run('--dgn-data', other, '--apply', '--may-spend');
        expect(code).toBe(2);
        expect(text).toContain(`--dgn-data does not go with ${other}. Nothing done.`);
      }
      expect(parserCalls).toEqual([]);
    });
  });

  describe('--pdf: PDFs already on a box, with no model', () => {
    /** The parser's answer for a one-page PDF of this kind. */
    const drawing =
      (kind: string): Reply =>
      () =>
        Response.json({
          ok: true,
          numPages: 1,
          pageCountMayBeShort: false,
          allRead: true,
          kind,
          sample: kind === 'unsure' ? 'A MADE UP TITLE OF A MADE UP DRAWING SHEET' : '',
          pages: [
            {
              page: 1,
              status: 'ok',
              class: kind === 'document' ? 'text' : 'vector_text',
              size: 'a1',
              widthMm: 841,
              heightMm: 594,
              rotate: 0,
              chars: 4000,
              runs: 700,
              hiddenShare: 0,
              imageCover: 0,
              segments: 20000,
              axes: { h: 0.6, v: 0.3, iso: 0.01, other: 0.09, longMm: 60000 },
              tagLike: 40,
              instruments: 30,
              lineNumbers: 12,
              markups: 0,
              markupsWithText: 0,
              kind,
              eye: null,
            },
          ],
        });
    const DRAWING_URL = 'http://parser.test:8095/pdf/drawing';

    it('the plain run leaves a PDF out, and a --pdf dry run lists PDFs only and reads nothing', async () => {
      const pdf = await upload(unique('pdf'), 'a made-up drawing, dry');
      const sheet = await upload(unique('xlsx'), 'workbook beside a pdf');
      const plain = await run(scoped(pdf.id, sheet.id));
      expect(plain.text).toContain(`${pdf.id}: skipped: not-a-candidate`);
      expect(plain.text).toContain(`${sheet.id}: would read`);
      const { code, text } = await run(scoped(pdf.id, sheet.id), '--pdf');
      expect(code).toBe(0);
      expect(text).toContain(`${pdf.id}: would read${r.PDF_DRY_RUN}`);
      expect(text).toContain(`${sheet.id}: skipped: not-a-candidate`);
      expect(parserCalls).toEqual([]);
      expect(namesOf(pdf.id)).toEqual([]);
    });

    it('a drawing gets its database; a second run asks nothing', async () => {
      const bytes = 'a made-up drawing, built';
      const file = await upload(unique('pdf'), bytes);
      reply = drawing('pid');
      const { code, text } = await run(scoped(file.id), '--pdf', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${file.id}: built (2 tabs, 2 rows)`);
      expect(namesOf(file.id)).toEqual([sqlite(bytes)]);
      expect(parserCalls).toEqual([DRAWING_URL]);
      expect((await run(scoped(file.id), '--pdf', '--apply')).text).toContain('1 already built');
      expect(parserCalls).toEqual([DRAWING_URL]);
    });

    it('a document gets no name, is counted, and the next run reads it again', async () => {
      const file = await upload(unique('pdf'), 'a made-up letter');
      reply = drawing('document');
      const { code, text } = await run(scoped(file.id), '--pdf', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${file.id}: skipped: not-drawing`);
      expect(namesOf(file.id)).toEqual([]);
      await run(scoped(file.id), '--pdf', '--apply');
      expect(parserCalls).toEqual([DRAWING_URL, DRAWING_URL]);
    });

    it('an unsure file gets a database that says unsure: the parser is the only call', async () => {
      const bytes = 'a made-up unsure drawing';
      const file = await upload(unique('pdf'), bytes);
      reply = drawing('unsure');
      const { text } = await run(scoped(file.id), '--pdf', '--apply');
      expect(text).toContain(`${file.id}: built`);
      expect(namesOf(file.id)).toEqual([sqlite(bytes)]);
      // Every request of this process goes through the faked fetch: no
      // decider and no other model was asked.
      expect(parserCalls).toEqual([DRAWING_URL]);
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const db = new DatabaseSync(f.fileDbPaths(file.id, sha256(bytes))!.sqlite, {
        readOnly: true,
      });
      const row = db.prepare(`SELECT * FROM "File"`).get() as Record<string, unknown>;
      db.close();
      expect(row).toMatchObject({ Kind: 'unsure', 'Kind source': 'rules', 'Decider answer': null });
    });

    it('a read that fails with a verdict earns the word, and --again reads it once more', async () => {
      const bytes = 'a made-up broken pdf';
      const file = await upload(unique('pdf'), bytes);
      reply = failing('failed', 422);
      await run(scoped(file.id), '--pdf', '--apply');
      expect(namesOf(file.id)).toEqual([none(bytes)]);
      parserCalls.length = 0;
      reply = drawing('pid');
      expect((await run(scoped(file.id), '--pdf', '--apply')).text).toContain(
        '1 already have a word',
      );
      expect(parserCalls).toEqual([]);
      const healed = await run(scoped(file.id), '--pdf', '--again', '--apply');
      expect(healed.text).toContain(`${file.id}: built`);
      expect(namesOf(file.id)).toEqual([sqlite(bytes)]);
    });

    it("--again leaves a PDF's no-rows alone: it is the decider's answer, and no decider reads here", async () => {
      const bytes = 'a made-up letter the decider named';
      const file = await upload(unique('pdf'), bytes);
      await f.writeFileDbNone(file.id, sha256(bytes), 'no-rows', { parsed: true });
      reply = drawing('unsure');
      const { text } = await run(scoped(file.id), '--pdf', '--again', '--apply');
      expect(text).toContain('1 already have a word');
      expect(parserCalls).toEqual([]);
      expect(namesOf(file.id)).toEqual([none(bytes)]);
    });

    it('a private PDF is skipped and read never', async () => {
      const file = await upload(unique('pdf'), 'a made-up private drawing');
      await setData(file.id, { indexing: 'metadata' });
      const { text } = await run(scoped(file.id), '--pdf', '--apply');
      expect(text).toContain(`${file.id}: skipped: private`);
      expect(parserCalls).toEqual([]);
    });

    it('prints no file name', async () => {
      const name = unique('pdf');
      const file = await upload(name, 'a made-up drawing, words');
      reply = drawing('pid');
      const { text } = await run(scoped(file.id), '--pdf', '--apply');
      expect(text).toContain('built');
      expect(text).not.toContain(name);
    });

    it('is refused with --dgn-data, --table, --orphans and --count, before anything is read', async () => {
      for (const other of ['--table', '--orphans', '--count']) {
        const { code, text } = await run('--pdf', other, '--apply', '--may-spend');
        expect(code).toBe(2);
        expect(text).toContain(`--pdf does not go with ${other}. Nothing done.`);
      }
      const both = await run('--pdf', '--dgn-data', '--apply');
      expect(both.code).toBe(2);
      expect(both.text).toContain('--pdf does not go with --dgn-data');
      expect(parserCalls).toEqual([]);
    });
  });

  describe('--dwg-reader: a DWG read before the ezdwg reader gets its result', () => {
    /** DWG magic, then made-up bytes: the sniff takes it. */
    const dwgBytes = () => Buffer.concat([Buffer.from('AC1032'), Buffer.from(randomUUID())]);
    /** The CAD tier's reply in the shapes it really sends: the ezdwg reader
     *  sends its `dwg` record; the old image sends none, as `dwg2dxf` or as
     *  the `ezdwg` name of its fallback converter. */
    const dwgReply =
      (kind: 'reader' | 'old' | 'old-fallback'): Reply =>
      () =>
        Response.json({
          converter: kind === 'old' ? 'dwg2dxf' : 'ezdwg',
          layers: [{ name: 'Pipe', count: 1 }],
          texts: [{ text: 'NOTE 1', layer: 'Pipe', x: 1, y: 2 }],
          counts: { LINE: 1 },
          ...(kind === 'reader'
            ? { dwg: { objects: 1, converted: 1, not_converted_total: 0, not_converted: [] } }
            : {}),
        });
    /** Uploads, each with a database from the old converter (its name only),
     *  in id order (the run's). */
    const olds = async (...made: Buffer[]) => {
      const files = [];
      for (const bytes of made) {
        const file = await upload(unique('dwg'), bytes);
        mkdirSync(f.fileDbsDir(), { recursive: true });
        const abs = path.join(f.fileDbsDir(), `${file.id}.${sqlite(bytes)}`);
        writeFileSync(abs, 'old database');
        files.push({ id: file.id, bytes, abs });
      }
      return files.sort((p, q) => (p.id < q.id ? -1 : 1));
    };
    const isNew = (abs: string) =>
      readFileSync(abs).subarray(0, 15).toString() === 'SQLite format 3';

    beforeEach(() => {
      h.realCad = true;
    });

    it('takes a built DWG with the flag and builds it again, with the parser alone', async () => {
      const [file] = await olds(dwgBytes());
      reply = dwgReply('reader');
      const { code, text } = await run(scoped(file!.id), '--dwg-reader', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${file!.id}: built (`);
      expect(namesOf(file!.id)).toEqual([sqlite(file!.bytes)]);
      expect(isNew(file!.abs)).toBe(true);
      expect(parserCalls).toHaveLength(1); // the guard and the build share one exchange
      for (const call of parserCalls)
        expect(call).toMatch(/^http:\/\/parser\.test:8095\/dwg\/render/);
      expect(h.commits).toBe(0); // no Table
    });

    it('without the flag a built DWG is left alone', async () => {
      const [file] = await olds(dwgBytes());
      reply = dwgReply('reader');
      const { text } = await run(scoped(file!.id), '--apply');
      expect(text).toContain('1 already built');
      expect(parserCalls).toEqual([]);
      expect(readFileSync(file!.abs).toString()).toBe('old database');
    });

    it('a dry run lists DWG files only, built or not, and reads nothing', async () => {
      const [built] = await olds(dwgBytes());
      const fresh = await upload(unique('dwg'), dwgBytes());
      const sheet = await upload(unique('xlsx'), 'workbook beside a dwg');
      const dgn = await upload(unique('dgn'), Buffer.from('not read'));
      const { code, text } = await run(
        scoped(built!.id, fresh.id, sheet.id, dgn.id),
        '--dwg-reader',
      );
      expect(code).toBe(0);
      expect(text).toContain(`${built!.id}: would read${r.DWG_DRY_RUN}`);
      expect(text).toContain(`${fresh.id}: would read${r.DWG_DRY_RUN}`);
      expect(text).toContain(`${sheet.id}: skipped: not-a-candidate`);
      expect(text).toContain(`${dgn.id}: skipped: not-a-candidate`);
      expect(parserCalls).toEqual([]);
    });

    it('the old converter stops the run there, writes nothing and says how to go past', async () => {
      for (const kind of ['old', 'old-fallback'] as const) {
        parserCalls.length = 0;
        f.resetParserFailures();
        const [first, second] = await olds(dwgBytes(), dwgBytes());
        reply = dwgReply(kind);
        const { code, text } = await run(scoped(first!.id, second!.id), '--dwg-reader', '--apply');
        expect(code).toBe(1);
        expect(text).toContain(
          `${first!.id}: nothing written: the parser reads DWG with the old reader`,
        );
        expect(text).toContain('STOPPED: 1 refused old-reader');
        expect(text).toContain('The parser reads DWG with the old converter, not the ezdwg reader');
        expect(text).toContain(`run again with --after=${first!.id}`);
        expect(readFileSync(first!.abs).toString()).toBe('old database');
        expect(readFileSync(second!.abs).toString()).toBe('old database');
        expect(parserCalls).toHaveLength(1); // the second file is never read
      }
    });

    it('a .dwg name that holds other bytes is skipped with no parser call, and the run goes on', async () => {
      const [good] = await olds(dwgBytes());
      const other = await upload(unique('dwg'), Buffer.from('not a drawing at all'));
      reply = dwgReply('reader');
      const { code, text } = await run(scoped(other.id, good!.id), '--dwg-reader', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${other.id}: skipped: not-dwg`);
      expect(text).toContain(`${good!.id}: built (`);
      expect(parserCalls).toHaveLength(1);
    });

    it('--limit cuts and --after goes on, as with --dgn-data', async () => {
      const [a, b] = await olds(dwgBytes(), dwgBytes());
      reply = dwgReply('reader');
      const first = await run(scoped(a!.id, b!.id), '--dwg-reader', '--limit=1', '--apply');
      expect(first.code).toBe(0);
      expect(first.text).toContain(`--after=${a!.id}`);
      expect(readFileSync(b!.abs).toString()).toBe('old database');
      const next = await run(scoped(a!.id, b!.id), '--dwg-reader', `--after=${a!.id}`, '--apply');
      expect(next.code).toBe(0);
      expect(next.text).toContain(`${b!.id}: built (`);
      expect(next.text).not.toContain(`${a!.id}: reading`);
    });

    it('is refused with --dgn-data, --table, --orphans and --count, before anything is read', async () => {
      for (const other of ['--table', '--orphans', '--count']) {
        const { code, text } = await run('--dwg-reader', other, '--apply', '--may-spend');
        expect(code).toBe(2);
        expect(text).toContain(`--dwg-reader does not go with ${other}. Nothing done.`);
      }
      for (const argv of [
        ['--dgn-data', '--dwg-reader'],
        ['--dwg-reader', '--dgn-data'],
      ]) {
        const { code, text } = await run(...argv, '--apply');
        expect(code).toBe(2);
        expect(text).toContain('--dgn-data does not go with --dwg-reader. Nothing done.');
      }
      expect(parserCalls).toEqual([]);
    });
  });

  describe('--symbols: a drawing read before the symbols pass gets its symbols', () => {
    const dwgBytes = () => Buffer.concat([Buffer.from('AC1032'), Buffer.from(randomUUID())]);
    const dxfBytes = () => Buffer.from(`0\nSECTION\n2\nHEADER\n999\n${randomUUID()}\n0\nENDSEC\n`);
    /** The CAD tier's reply: with the symbols pass, its `symbols` (empty
     *  for a drawing with no INSERT); an image before it sends none. */
    const symbolsReply =
      (kind: 'symbols' | 'old'): Reply =>
      () =>
        Response.json({
          converter: 'ezdwg',
          layers: [{ name: 'Pipe', count: 1 }],
          texts: [{ text: 'NOTE 1', layer: 'Pipe', x: 1, y: 2 }],
          counts: { INSERT: 1 },
          dwg: { objects: 1, converted: 1, not_converted_total: 0, not_converted: [] },
          ...(kind === 'symbols'
            ? {
                symbols: [
                  {
                    key: 'aaaaaaaaaaaaaaaa',
                    shape: 'ssssssssssssssss',
                    name: 'GATE',
                    kind: 'symbol',
                    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
                    x0: 0,
                    y0: 0,
                    width: 1,
                    height: 1,
                    tags: [],
                    placements: 1,
                  },
                ],
                placements: [
                  {
                    key: 'aaaaaaaaaaaaaaaa',
                    x: 1,
                    y: 2,
                    rotation: 0,
                    xscale: 1,
                    yscale: 1,
                    layer: 'Pipe',
                    handle: '1A',
                    tags: {},
                  },
                ],
                symbols_error: null,
              }
            : {}),
        });
    /** Uploads, each with an old database (its name only), in id order. */
    const olds = async (...made: [string, Buffer][]) => {
      const files = [];
      for (const [ext, bytes] of made) {
        const file = await upload(unique(ext), bytes);
        mkdirSync(f.fileDbsDir(), { recursive: true });
        const abs = path.join(f.fileDbsDir(), `${file.id}.${sqlite(bytes)}`);
        writeFileSync(abs, 'old database');
        files.push({ id: file.id, bytes, abs });
      }
      return files.sort((p, q) => (p.id < q.id ? -1 : 1));
    };
    const isNew = (abs: string) =>
      readFileSync(abs).subarray(0, 15).toString() === 'SQLite format 3';

    beforeEach(() => {
      h.realCad = true;
    });

    it('takes built DWG and DXF files with the flag and builds them again, with the parser alone', async () => {
      const files = await olds(['dwg', dwgBytes()], ['dxf', dxfBytes()]);
      reply = symbolsReply('symbols');
      const { code, text } = await run(scoped(...files.map((x) => x.id)), '--symbols', '--apply');
      expect(code).toBe(0);
      for (const file of files) {
        expect(text).toContain(`${file.id}: built (`);
        expect(isNew(file.abs)).toBe(true);
      }
      expect(parserCalls).toHaveLength(2); // the guard and the build share one exchange each
      expect(h.commits).toBe(0); // no Table
    });

    it('a dry run lists CAD files only, built or not, and reads nothing', async () => {
      const [built] = await olds(['dgn', Buffer.from('not read')]);
      const fresh = await upload(unique('dxf'), dxfBytes());
      const sheet = await upload(unique('xlsx'), 'workbook beside a drawing');
      const { code, text } = await run(scoped(built!.id, fresh.id, sheet.id), '--symbols');
      expect(code).toBe(0);
      expect(text).toContain(`${built!.id}: would read${r.SYMBOLS_DRY_RUN}`);
      expect(text).toContain(`${fresh.id}: would read${r.SYMBOLS_DRY_RUN}`);
      expect(text).toContain(`${sheet.id}: skipped: not-a-candidate`);
      expect(parserCalls).toEqual([]);
    });

    it('an image with no symbols pass stops the run there and writes nothing', async () => {
      const [first, second] = await olds(['dwg', dwgBytes()], ['dwg', dwgBytes()]);
      reply = symbolsReply('old');
      const { code, text } = await run(scoped(first!.id, second!.id), '--symbols', '--apply');
      expect(code).toBe(1);
      expect(text).toContain(`${first!.id}: nothing written: the parser has no symbols pass`);
      expect(text).toContain('STOPPED: 1 refused old-reader');
      expect(text).toContain('The parser has no symbols pass');
      expect(text).toContain(`run again with --after=${first!.id}`);
      expect(readFileSync(first!.abs).toString()).toBe('old database');
      expect(readFileSync(second!.abs).toString()).toBe('old database');
      expect(parserCalls).toHaveLength(1);
    });

    it('a drawing name that holds other bytes is skipped with no parser call', async () => {
      const [good] = await olds(['dwg', dwgBytes()]);
      const other = await upload(unique('dxf'), Buffer.from('not a drawing at all'));
      reply = symbolsReply('symbols');
      const { code, text } = await run(scoped(other.id, good!.id), '--symbols', '--apply');
      expect(code).toBe(0);
      expect(text).toContain(`${other.id}: skipped: not-cad`);
      expect(text).toContain(`${good!.id}: built (`);
      expect(parserCalls).toHaveLength(1);
    });

    it('is refused with another rebuild or mode, before anything is read', async () => {
      for (const other of ['--table', '--orphans', '--count']) {
        const { code, text } = await run('--symbols', other, '--apply', '--may-spend');
        expect(code).toBe(2);
        expect(text).toContain(`--symbols does not go with ${other}. Nothing done.`);
      }
      for (const first of ['--pdf', '--dgn-data', '--dwg-reader']) {
        const { code, text } = await run('--symbols', first, '--apply');
        expect(code).toBe(2);
        expect(text).toContain(`${first} does not go with --symbols. Nothing done.`);
      }
      expect(parserCalls).toEqual([]);
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

    it('--apply refuses when names exist and no row matches any: a wrong database', async () => {
      const dir = f.fileDbsDir();
      const aside = `${dir}.aside`;
      mkdirSync(dir, { recursive: true });
      renameSync(dir, aside);
      try {
        const gone = `${randomUUID()}.0123456789abcdef.sqlite`;
        touch(gone);
        const { code, text } = await run('--orphans', '--apply');
        expect(code).toBe(1);
        expect(text).toContain('Nothing removed');
        expect(existsSync(path.join(dir, gone))).toBe(true);
        // The list still lists: only the removal refuses.
        expect((await run('--orphans')).code).toBe(0);

        // An empty folder has nothing to refuse.
        rmSync(path.join(dir, gone));
        expect((await run('--orphans', '--apply')).code).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        renameSync(aside, dir);
      }
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

    describe('a file that changed after its Table was made', () => {
      const built = async (bytes: string) => {
        const file = await withTable(bytes, [tabOf('A', [['1'], ['2'], ['3']])]);
        reply = grid([sheetOf('A', 2)]);
        await run(scoped(file.id), '--apply');
        return file;
      };
      const setOldTable = (fileId: string, change: ReturnType<typeof sqlTag>) =>
        x(sqlTag`update nodes set ${change}
          where type = 'table' and data->>'sourceFileId' = ${fileId}`);
      const aged = () => sqlTag`created_at = now() - interval '2 hours'`;

      it('by the dates: counted as replaced, and the run passes', async () => {
        const file = await built('count replaced late');
        await setOldTable(file.id, aged());
        const { code, text } = await run('--count', scoped(file.id));
        expect(code).toBe(0);
        expect(text).toContain('1 replaced');
        expect(text).toMatch(/PASS/);
        expect(text).not.toContain('old 3, database 2');
      });

      it('by a drawing stamp of other bytes, however new the Table', async () => {
        const file = await built('count replaced stamp');
        await setOldTable(
          file.id,
          sqlTag`data = data || ${JSON.stringify({ sourceSha256: 'b'.repeat(64) })}::jsonb`,
        );
        const { code, text } = await run('--count', scoped(file.id));
        expect(code).toBe(0);
        expect(text).toContain('1 replaced');
      });

      it('a stamp of these bytes is a real difference, however old the Table', async () => {
        const bytes = 'count stamp holds';
        const file = await built(bytes);
        await setOldTable(
          file.id,
          sqlTag`data = data || ${JSON.stringify({ sourceSha256: sha256(bytes) })}::jsonb, ${aged()}`,
        );
        const { code, text } = await run('--count', scoped(file.id));
        expect(code).toBe(1);
        expect(text).toContain(`${file.id}: tab 1: old 3, database 2`);
        expect(text).not.toContain('replaced');
      });

      it('with no database it still fails: nothing there to read', async () => {
        const file = await withTable('count replaced unbuilt', [tabOf('A', [['1']])]);
        await setOldTable(file.id, aged());
        const { code, text } = await run('--count', scoped(file.id));
        expect(code).toBe(1);
        expect(text).toContain(`${file.id}: no database`);
      });
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

    it('a row with no valid sha256 has its own line, not the count that must clear', async () => {
      const before = (await counts()).n;
      const file = await upload(unique('xlsx'), 'probe no sha');
      await x(sqlTag`update nodes set data = data - 'sha256' where id = ${file.id}`);
      const after = await counts();
      expect(after.n.file_db_missing).toBe(before.file_db_missing);
      expect(after.n.file_db_no_sha).toBe(before.file_db_no_sha! + 1);
      expect((await run(scoped(file.id), '--apply')).text).toContain('skipped: no-sha');
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
