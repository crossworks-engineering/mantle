/**
 * With the line, a file has no Table, and search does not need one: the real
 * extractNode on a drawing and on an Excel makes no table node, and the
 * search_chunks tool finds each file by a value in it.
 * And a private drawing costs nothing: no database, no Table, no child image,
 * no model call, no parser call.
 *
 * The parser is faked at the fetch, the model is a fake chat adapter that counts
 * its calls, and the embedder gives each text its own vector, so the keyword arm
 * is what finds a value. The bytes, the rows and the chunks are real. A migrated
 * scratch database, dropped after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/no-table.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import { DWG_ANSWERS_KEY, DWG_VERIFY_RUNS_KEY } from '@mantle/files/dwg-keys';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIM = 768;
const DWG_VALUE = 'K-90417';
const XLS_VALUE = 'V-55261';
const ANSWERS_ON_ROW = JSON.stringify({ [DWG_ANSWERS_KEY]: [1], [DWG_VERIFY_RUNS_KEY]: [2] });
const XLS_TEXT = `# Sheet: Valves\nTag,Service,Size\n${XLS_VALUE},Hot oil return header,150\nV-55262,Cooling water supply,100\n`;

const h = vi.hoisted(() => ({ modelCalls: 0, texts: [] as string[] }));

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
  const chat = async () => {
    h.modelCalls += 1;
    return {
      text: JSON.stringify({ summary: 'A summary.', entities: [], facts: [], relations: [] }),
      model: 'fake/extractor',
    };
  };
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

/** A drawing's bytes: the magic, then something unique, never real bytes. */
const dwgBytes = () =>
  Buffer.concat([Buffer.from('AC1027', 'latin1'), Buffer.from(randomUUID()), Buffer.alloc(64)]);

/** The CAD tier's reply: a registry with no picture, so no child image. */
const dwgReply = () => ({
  ok: true,
  dpi: 300,
  converter: 'dwg2dxf',
  version: 'AC1027',
  entities: 42,
  capped: false,
  layers: [{ name: 'ANNOTATION', count: 42 }],
  texts: [
    { text: DWG_VALUE, layer: 'ANNOTATION', x: 10.5, y: 20.1 },
    { text: 'DN150', layer: 'ANNOTATION', x: 11, y: 21 },
  ],
  counts: { TEXT: 42 },
  render_error: null,
});

describe.skipIf(!URL)('a file with no Table', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('@mantle/files');
  let m: Db;
  let f: Files;
  let extractNode: typeof import('../extractor').extractNode;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-no-table-'));
  const parserCalls: string[] = [];

  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A folder homed in the team's workspace. Its files take that home. */
  const folder = (slug: string, data: Record<string, unknown> = {}) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: slug }], (tx) =>
        tx.execute(sql`
          insert into nodes (id, owner_id, type, title, path, data) values
            (${randomUUID()}, ${anchor}, 'branch', ${slug}, ${slug}::ltree,
             ${JSON.stringify(data)}::jsonb)`),
      ),
    );
  const upload = (name: string, bytes: Buffer | string, parentPath = 'files.m1') =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({ ownerId: anchor, parentPath, filename: name, bytes: Buffer.from(bytes) }),
    );
  const tablesOf = (id: string) =>
    x<{ id: string }>(sql`
      select id from nodes where type = 'table' and data->>'sourceFileId' = ${id}`);
  const childrenOf = (id: string) =>
    x<{ id: string }>(sql`
      select id from nodes where type = 'file' and data->>'sourceFileId' = ${id}`);
  const dataOf = async (id: string) =>
    (await x<{ data: Record<string, unknown> }>(sql`select data from nodes where id = ${id}`))[0]!
      .data;
  const namesOf = (id: string) =>
    existsSync(f.fileDbsDir()) ? readdirSync(f.fileDbsDir()).filter((n) => n.startsWith(id)) : [];
  const chunksOf = (id: string) =>
    x<{ n: number }>(sql`select count(*)::int as n from content_chunks where node_id = ${id}`);

  const search = async (q: string) => {
    const { getBuiltin } = await import('@mantle/tools');
    const tool = getBuiltin('search_chunks')!;
    const r = await tool.handler({ q, limit: 5 }, { ownerId: anchor } as never);
    expect(r.ok).toBe(true);
    return (r as unknown as { output: { nodeId: string; text: string }[] }).output;
  };

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
    // As a brain has it: homes need the Admin workspace.
    await su(sql`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sql`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await folder('files.m1');
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    h.modelCalls = 0;
    parserCalls.length = 0;
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const route = new globalThis.URL(String(url)).pathname;
        parserCalls.push(route);
        if (route === '/dwg/render') return Response.json(dwgReply());
        if (route === '/text') return Response.json({ text: XLS_TEXT });
        if (route === '/images') return Response.json({ images: [], rejected: {}, candidates: 0 });
        if (route === '/grid') {
          return Response.json({
            sheets: [
              {
                name: 'Valves',
                columns: [
                  { name: 'Tag', type: 'text' },
                  { name: 'Size', type: 'number' },
                ],
                rows: [[XLS_VALUE, 150]],
              },
            ],
            plan: null,
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

  describe('with the line', () => {
    beforeEach(() => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
    });

    it('a drawing: no table node, its database, and found by a value in it', async () => {
      const file = await upload(`${randomUUID().slice(0, 8)}.dwg`, dwgBytes());
      await extractNode(file.id, anchor);
      expect(await tablesOf(file.id)).toEqual([]);
      expect(namesOf(file.id)).toHaveLength(1);
      expect((await dataOf(file.id)).extract_completed_at).toBeTruthy();
      const hits = await search(DWG_VALUE);
      expect(hits.map((hit) => hit.nodeId)).toContain(file.id);
      expect(hits.find((hit) => hit.nodeId === file.id)!.text).toContain(DWG_VALUE);
    });

    it('an Excel: no table node, its database, and found by a value in it', async () => {
      const file = await upload(`${randomUUID().slice(0, 8)}.xlsx`, randomUUID());
      await extractNode(file.id, anchor);
      expect(await tablesOf(file.id)).toEqual([]);
      expect(namesOf(file.id)).toHaveLength(1);
      expect((await dataOf(file.id)).extract_completed_at).toBeTruthy();
      const hits = await search(XLS_VALUE);
      expect(hits.map((hit) => hit.nodeId)).toContain(file.id);
      expect(hits.find((hit) => hit.nodeId === file.id)!.text).toContain(XLS_VALUE);
    });
  });

  describe('a private drawing', () => {
    it('no database, no Table, no child image, no model call, no parser call', async () => {
      // On a box with no line: the hole this closes is there today.
      const file = await upload(`${randomUUID().slice(0, 8)}.dwg`, dwgBytes());
      await x(sql`update nodes set data = data || '{"indexing":"metadata"}'::jsonb
        where id = ${file.id}`);
      await extractNode(file.id, anchor);
      expect(namesOf(file.id)).toEqual([]);
      expect(await tablesOf(file.id)).toEqual([]);
      expect(await childrenOf(file.id)).toEqual([]);
      expect(h.modelCalls).toBe(0);
      expect(parserCalls).toEqual([]);
      expect(await chunksOf(file.id)).toEqual([{ n: 0 }]);
      expect((await dataOf(file.id)).indexing_applied).toBe('metadata');
    });

    it('so does a file in a flagged folder', async () => {
      const flagged = `files.private_${randomUUID().slice(0, 8)}`;
      await folder(flagged, { indexing: 'metadata' });
      const file = await upload(`${randomUUID().slice(0, 8)}.dwg`, dwgBytes(), flagged);
      await extractNode(file.id, anchor);
      expect(namesOf(file.id)).toEqual([]);
      expect(await tablesOf(file.id)).toEqual([]);
      expect(h.modelCalls).toBe(0);
      expect(parserCalls).toEqual([]);
    });
  });

  describe('a flip', () => {
    it('a repeat flip: answers on a private row go, with its date kept and no reset', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const slug = `files.f${randomUUID().slice(0, 8)}`;
      await folder(slug);
      const file = await upload(`${randomUUID().slice(0, 8)}.dwg`, dwgBytes(), slug);
      await f.setIndexingMode({ ownerId: anchor, nodeId: file.id, mode: 'metadata' });
      await extractNode(file.id, anchor);
      expect((await dataOf(file.id)).indexing_applied).toBe('metadata');

      await x(sql`update nodes set data = data || ${ANSWERS_ON_ROW}::jsonb where id = ${file.id}`);
      const dateOf = async () =>
        (
          await x<{ at: string }>(
            sql`select updated_at::text as at from nodes where id = ${file.id}`,
          )
        )[0]!.at;
      const before = await dateOf();
      const [dir] = await x<{ id: string }>(sql`
        select id from nodes where type = 'branch' and path = ${slug}::ltree`);
      const { requeued } = await f.setIndexingMode({
        ownerId: anchor,
        nodeId: dir!.id,
        mode: 'metadata',
      });
      expect(requeued).toBe(0);
      const flipped = await dataOf(file.id);
      expect(flipped[DWG_ANSWERS_KEY]).toBeUndefined();
      expect(flipped[DWG_VERIFY_RUNS_KEY]).toBeUndefined();
      expect(flipped.index_work).toBeUndefined();
      expect(await dateOf()).toBe(before);
    });

    it('to private: the answers go at once, the names at the extract; back: it rebuilds', async () => {
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      const file = await upload(`${randomUUID().slice(0, 8)}.dwg`, dwgBytes());
      await extractNode(file.id, anchor);
      expect(namesOf(file.id)).toHaveLength(1);
      await x(sql`update nodes set data = data || ${ANSWERS_ON_ROW}::jsonb where id = ${file.id}`);

      await f.setIndexingMode({ ownerId: anchor, nodeId: file.id, mode: 'metadata' });
      const flipped = await dataOf(file.id);
      expect(flipped[DWG_ANSWERS_KEY]).toBeUndefined();
      expect(flipped[DWG_VERIFY_RUNS_KEY]).toBeUndefined();
      expect(flipped.summary).toBeUndefined();
      expect(namesOf(file.id)).toHaveLength(1);

      await extractNode(file.id, anchor);
      expect(namesOf(file.id)).toEqual([]);
      expect((await dataOf(file.id)).indexing_applied).toBe('metadata');

      await f.setIndexingMode({ ownerId: anchor, nodeId: file.id, mode: 'full' });
      await extractNode(file.id, anchor);
      expect(namesOf(file.id)).toHaveLength(1);
      expect(await tablesOf(file.id)).toEqual([]);
    });

    it('a table_from_file on a private file is a person asking: no change to createTable', async () => {
      // B4: the skip is the extract's, and createTable has no private check.
      const c = await import('@mantle/content');
      const file = await upload(`${randomUUID().slice(0, 8)}.csv`, 'tag\nP-1\n');
      await x(sql`update nodes set data = data || '{"indexing":"metadata"}'::jsonb
        where id = ${file.id}`);
      const made = await m.createPartOfFile(
        file.id,
        () =>
          c.createTable(anchor, {
            title: 'By hand',
            tabs: [
              {
                ...c.tableDocFromGrid({
                  columns: [{ name: 'Tag', type: 'text' }],
                  rows: [['P-1']],
                }),
                name: 'S',
              },
            ],
            sourceFileId: file.id,
          }),
        (t) => c.deleteTable(anchor, t.id),
      );
      expect(made.id).toBeTruthy();
    });
  });
});
