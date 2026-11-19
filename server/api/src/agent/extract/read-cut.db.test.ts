/**
 * A read in part, said on the file (docs/files.md, "Read in part"), through
 * the real extractNode on a migrated scratch database: the parser's text
 * answer carries the reader's cuts (a workbook past its row cap), the
 * extractor adds its own (the stored text past its limit), and the stamp
 * that ends the read writes both as `data.read_cut`. The file row then says
 * `partial` with the cuts and their sentences, and the `partial` list finds
 * it. New bytes drop the cuts with the other byte keys.
 *
 * The parser is faked at the fetch, the model is a fake chat adapter, the
 * embedder gives each text its own vector. Generated data only.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/read-cut.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIM = 768;

const h = vi.hoisted(() => ({
  texts: [] as string[],
  text: '',
  cuts: {} as Record<string, unknown>,
}));

function vectorOf(text: string): number[] {
  let i = h.texts.indexOf(text);
  if (i < 0) i = h.texts.push(text) - 1;
  return Array.from({ length: DIM }, (_, k) => (k === (i % (DIM - 1)) + 1 ? 1 : 0));
}

vi.mock('@mantle/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/embeddings')>();
  return {
    ...actual,
    embed: async (_o: string, text: string) => vectorOf(text),
    embedBatch: async (_o: string, texts: string[]) => texts.map(vectorOf),
    chunkWindowsEnabled: async () => false,
  };
});
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => ({
    text: JSON.stringify({ summary: 'A summary.', entities: [], facts: [], relations: [] }),
    model: 'fake/extractor',
  });
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'local', adapterName: 'fake-chat', chat })),
  };
});
vi.mock('./model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./model')>();
  return {
    ...actual,
    resolveExtractor: async () => ({
      id: '00000000-0000-4000-8000-0000000000e1',
      slug: 'extractor',
      provider: 'local',
      model: 'fake/extractor',
      apiKeyId: null,
      systemPrompt: null,
      params: { target_types: ['*'], extract_facts: false },
    }),
  };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, resolveChatKey: async () => ({ ok: true }) };
});
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, llmWorkAllowed: async () => true };
});

describe.skipIf(!URL)('a file read in part says so', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('@mantle/files');
  let m: Db;
  let f: Files;
  let extractNode: typeof import('../extractor').extractNode;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-read-cut-'));

  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const dataOf = async (id: string) =>
    (await x<{ data: Record<string, unknown> }>(sql`select data from nodes where id = ${id}`))[0]!
      .data;
  const upload = (name: string, bytes: Buffer | string) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: 'files.rc',
        filename: name,
        bytes: Buffer.from(bytes),
        overwrite: true,
      }),
    );

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    ({ extractNode } = await import('../extractor'));
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    await su(sql`insert into workspaces (id, owner_id, name)
      values (${team}, ${anchor}, ${`team ${team.slice(0, 8)}`})`);
    await su(sql`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sql`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: 'files.rc' }], (tx) =>
        tx.execute(sql`
          insert into nodes (id, owner_id, type, title, path, data) values
            (${randomUUID()}, ${anchor}, 'branch', 'files.rc', 'files.rc'::ltree, '{}'::jsonb)`),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    // No Table and no database pass: the text pass alone.
    vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const route = new globalThis.URL(String(url)).pathname;
        if (route === '/text') return Response.json({ ok: true, text: h.text, cuts: h.cuts });
        if (route === '/images') return Response.json({ images: [], rejected: {}, candidates: 0 });
        if (route === '/pipeline/run') {
          return Response.json({
            ok: true,
            result: {
              status: 'ok',
              calls: [{ call: 'tool', tool: 'file_tabs_write', input: { tabs: [] } }],
            },
            pictures: [],
          });
        }
        throw new Error(`no fake reply for ${route}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("the parser's cut and the stored text's cut are on the file, which reads as partial", async () => {
    // A generated workbook text past the store's 1,000,000 characters, and
    // the reader's word that it rendered 5,000 of 12,000 rows.
    h.text = `# Sheet: Rows\n${Array.from({ length: 60_000 }, (_, i) => `R-${i},${'v'.repeat(12)}`).join('\n')}`;
    h.cuts = { sheet_rows: { what: 'rows', read: 5000, total: 12_000, limit: 5000 } };
    const file = await upload(`${randomUUID().slice(0, 8)}.xlsx`, randomUUID());
    await extractNode(file.id, anchor);
    const data = await dataOf(file.id);
    expect(data.extract_completed_at).toBeTruthy();
    expect(data.read_cut).toEqual({
      sheet_rows: { what: 'rows', read: 5000, total: 12_000, limit: 5000 },
      text_store: {
        what: 'characters',
        read: 1_000_000,
        total: h.text.length,
        limit: 1_000_000,
      },
    });
    const [row] = await m.runAsSystem('queue:extract', () =>
      f.filesByIds({ ownerId: anchor, ids: [file.id] }),
    );
    expect(row?.extraction.state).toBe('partial');
    expect(row?.extraction.cuts?.map((c) => c.key)).toEqual(['sheet_rows', 'text_store']);
    expect(row?.extraction.hint).toMatch(/5,000 of 12,000 rows/);
    const partial = await m.runAsSystem('queue:extract', () =>
      f.listFilesByExtraction({ ownerId: anchor, state: 'partial' }),
    );
    expect(partial.files.map((p) => p.id)).toContain(file.id);
  }, 120_000);

  it('a read with no cut writes none, and new bytes drop an old one', async () => {
    h.text = '# Sheet: Small\nA,B\n1,2\n3,4\nfive,six\n';
    h.cuts = {};
    const name = `${randomUUID().slice(0, 8)}.xlsx`;
    const file = await upload(name, randomUUID());
    await extractNode(file.id, anchor);
    expect((await dataOf(file.id)).read_cut).toBeUndefined();
    // A cut on the node, then new bytes: dropped with the byte keys.
    await x(sql`update nodes set data = data || '{"read_cut": {"sheet_rows": {"what": "rows", "read": 1, "total": 2}}}'::jsonb
      where id = ${file.id}`);
    await upload(name, randomUUID());
    expect((await dataOf(file.id)).read_cut).toBeUndefined();
  }, 120_000);
});
