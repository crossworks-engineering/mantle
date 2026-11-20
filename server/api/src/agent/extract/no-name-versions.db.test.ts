/**
 * Versions are never guessed from file names (owner, 2026-11-20). Five sheets
 * of one drawing (`12-62-29-sht-01.md` .. `-05.md`) and two monthly reports in
 * one folder are seven files: the real extractNode reads each, and none is
 * marked superseded or down-weighted. The removed name pass took names that
 * differ only in runs of digits for versions and marked all but the newest
 * (reason 'version', salience 0.5). A file's versions are its own history:
 * the same name in the same folder with new bytes is the same node, its old
 * bytes kept as a version.
 *
 * The model is a fake chat adapter, the embedder gives each text its own
 * vector, and no parser is reached (text files). A migrated scratch database,
 * dropped after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/no-name-versions.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIM = 768;

const h = vi.hoisted(() => ({ texts: [] as string[] }));

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
    text: JSON.stringify({ summary: 'A drawing sheet.', entities: [], facts: [], relations: [] }),
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

const SHEETS = [1, 2, 3, 4, 5].map((n) => `12-62-29-sht-0${n}.md`);
const REPORTS = ['report-2026-02.md', 'report-2026-03.md'];

describe.skipIf(!URL)('versions are never guessed from file names', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('@mantle/files');
  let m: Db;
  let f: Files;
  let extractNode: typeof import('../extractor').extractNode;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-name-versions-'));

  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const write = (name: string, text: string, overwrite = false) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: 'files.nv',
        filename: name,
        bytes: Buffer.from(text),
        overwrite,
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
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: 'files.nv' }], (tx) =>
        tx.execute(sql`
          insert into nodes (id, owner_id, type, title, path)
          values (${randomUUID()}, ${anchor}, 'branch', 'nv', 'files.nv'::ltree)`),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads sheets and monthly reports as separate files, none superseded', async () => {
    const ids: string[] = [];
    for (const name of [...SHEETS, ...REPORTS]) {
      const row = await write(name, `${name}: the general arrangement, revision B, sheet notes.`);
      ids.push(row.id);
      await extractNode(row.id, anchor);
    }
    const rows = await x<{
      id: string;
      salience: number;
      superseded_by: string | null;
      superseded_reason: string | null;
      done: string | null;
    }>(sql`
      select id, salience, superseded_by, superseded_reason,
             data->>'extract_completed_at' as done
        from nodes where id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      // Read to the end, so the old pass (after the content index) would have run.
      expect(r.done, r.id).not.toBeNull();
      expect(r.superseded_by, r.id).toBeNull();
      expect(r.superseded_reason, r.id).toBeNull();
      expect(r.salience, r.id).toBe(1);
    }
  }, 120_000);

  it('a version is the same name in the same folder: one node, the old bytes kept', async () => {
    const first = await write('pump-list.md', 'Pump list, revision A: P-101, P-102.');
    const again = await write('pump-list.md', 'Pump list, revision B: P-101, P-102, P-103.', true);
    expect(again.id).toBe(first.id);
    const [n] = await x<{ n: number }>(sql`
      select count(*)::int as n from nodes
       where type = 'file' and path = 'files.nv'::ltree and slug = 'pump-list.md'`);
    expect(n!.n).toBe(1);
    const [kept] = await x<{ n: number }>(sql`
      select count(*)::int as n from node_snapshots where node_id = ${first.id}::uuid`);
    expect(kept!.n).toBe(1);
  });
});
