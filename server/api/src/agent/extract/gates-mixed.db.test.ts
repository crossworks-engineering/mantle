/**
 * An EDIT to a page the clean-derived mark flagged, before the hand-run
 * re-fold (workspaces plan 5.3, W2 re-audit): the edit nulls the node
 * vector and notifies the extractor. The gate must not spend a model call
 * and must not leave the page out of vector search: it indexes the page
 * locally from its live text (pages.doc, folded), stamps it refolded, and
 * keeps the mark. Against a real, migrated Postgres; the embedder, the
 * extractor config and the model key check are stubbed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/gates-mixed.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({
  vec: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
  resolveChatKey: vi.fn(),
  autoTable: vi.fn(),
  embeddedImages: vi.fn(),
}));

vi.mock('@mantle/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/embeddings')>();
  return {
    ...actual,
    embed: async () => h.vec,
    embedBatch: async (_o: string, texts: string[]) => texts.map(() => h.vec),
    chunkWindowsEnabled: async () => false,
  };
});
vi.mock('./model', () => ({
  resolveExtractor: async () => ({
    id: 'w1',
    slug: 'extractor',
    params: { target_types: ['*'] },
    apiKeyId: null,
  }),
}));
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, resolveChatKey: h.resolveChatKey };
});
vi.mock('./auto-table', () => ({ maybeAutoTableSpreadsheet: h.autoTable }));
vi.mock('./images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./images')>();
  return { ...actual, maybeExtractEmbeddedImages: h.embeddedImages };
});

describe.skipIf(!URL)('an edit to a marked page before the re-fold', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admitForExtraction: typeof import('./gates').admitForExtraction;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const file = randomUUID();
  const page = randomUUID();
  const SECRET = ['zanzibarquux', 'quokkaplinth'];
  const vecLit = `[${h.vec.join(',')}]`;
  const stale = `Pump overhaul notes.\n[Embedded file: ${SECRET[0]}.png]\n${SECRET[1]} calibration`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ admitForExtraction } = await import('./gates'));
    sqlTag = (await import('drizzle-orm')).sql;
    h.resolveChatKey.mockResolvedValue({ ok: true });
    h.autoTable.mockResolvedValue(undefined);
    h.embeddedImages.mockResolvedValue(undefined);
    const x = (q: ReturnType<typeof sqlTag>) => m.db.execute(q);
    await x(sqlTag`insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`gm-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`);
    await x(sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict do nothing`);
    await x(sqlTag`insert into nodes (id, owner_id, type, title, path)
      values (${file}, ${owner}, 'file', ${`${SECRET[0]}.png`}, 'files')`);
    // Marked by the migration (summary set aside), then edited: the edit
    // nulled the vector. Its chunk still holds the embed's words.
    await x(sqlTag`insert into nodes (id, owner_id, type, title, path, data, derived_mixed)
      values (${page}, ${owner}, 'page', 'Pump page', 'pages', '{}'::jsonb, true)`);
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Pump overhaul notes.' }] },
        { type: 'image', attrs: { nodeId: file, alt: `${SECRET[0]}.png`, src: null } },
      ],
    };
    await x(sqlTag`insert into pages (node_id, doc, doc_text)
      values (${page}, ${JSON.stringify(doc)}::jsonb, ${stale})`);
    await m.withHeads([page], 'update', (tx) =>
      tx.execute(sqlTag`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${owner}, ${page}, 0, ${stale}, ${vecLit}::vector)`),
    );
    await x(sqlTag`insert into node_mixed_summaries (node_id, summary)
      values (${page}, ${`old summary ${SECRET[1]}`})`);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    await m.db.execute(sqlTag`delete from node_mixed_summaries where node_id = ${page}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('indexes it from its live text with no model: no embed words, a vector, still marked', async () => {
    const r = await admitForExtraction(page, owner);
    expect(r.proceed).toBe(false);
    expect(h.resolveChatKey).not.toHaveBeenCalled();
    expect(h.autoTable).not.toHaveBeenCalled();
    expect(h.embeddedImages).not.toHaveBeenCalled();

    const chunks = (await m.db.execute(
      sqlTag`select text from content_chunks where node_id = ${page} order by ordinal`,
    )) as unknown as Array<{ text: string }>;
    expect(chunks.length).toBeGreaterThan(0);
    const all = chunks.map((c) => c.text).join('\n');
    expect(all).toContain('Pump overhaul notes.');
    expect(all).toContain('[embedded file]');
    for (const w of SECRET) expect(all).not.toContain(w);

    const [n] = (await m.db.execute(sqlTag`
      select embedding is not null as v, derived_mixed as d, data->>'refolded' as rf,
             data ? 'summary' as s, data->'extract_skipped'->>'reason' as skip
        from nodes where id = ${page}`)) as unknown as Array<{
      v: boolean;
      d: boolean;
      rf: string | null;
      s: boolean;
      skip: string | null;
    }>;
    expect(n).toEqual({
      v: true,
      d: true,
      rf: 'true',
      s: false,
      skip: 'derived_mixed_unrefolded',
    });
    const [side] = (await m.db.execute(
      sqlTag`select count(*)::int as c from node_mixed_summaries where node_id = ${page}`,
    )) as unknown as Array<{ c: number }>;
    expect(side!.c).toBe(1);

    // Re-folded now: the next notify goes on to the model as before.
    expect((await admitForExtraction(page, owner)).proceed).toBe(true);
  });
});
