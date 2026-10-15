/**
 * The page block-id repair is a compare-and-set (W8b): getPage reads a page
 * that has no block ids yet and writes the ids back later, fire-and-forget.
 * An autosave or a commit that lands between that read and that write must
 * win: the repair then writes nothing, and the next read repairs again.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/pages/block-id-repair.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBlockIds } from '@mantle/content-core/block-ids';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Doc = Record<string, unknown>;

describe.skipIf(!URL)('page block-id repair: a lost race writes nothing', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let read: typeof import('./read');
  let pages: typeof import('./index');
  const owner = randomUUID();

  const bare = (text: string): Doc => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A page whose doc and draft carry no block ids. */
  const mkPage = async (title: string): Promise<string> => {
    const id = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${id}, ${owner}, 'page'::node_type, ${title}, 'pages'::ltree)`);
    await x(sql`insert into pages (node_id, doc, draft_doc, draft_rev, draft_updated_at)
                values (${id}, ${JSON.stringify(bare('published words'))}::jsonb,
                        ${JSON.stringify(bare('draft words'))}::jsonb, 1, now())`);
    return id;
  };

  /** What getPage reads of the row (the repair's "seen"). */
  const seenOf = async (id: string) => {
    const [r] = await x<{ doc: Doc; draft_doc: Doc | null; draft_rev: number }>(
      sql`select doc, draft_doc, draft_rev from pages where node_id = ${id}`,
    );
    return { doc: r!.doc, draft: r!.draft_doc, draftRev: Number(r!.draft_rev) };
  };
  const rowText = async (id: string) =>
    (
      await x<{ doc: string; draft: string | null; rev: number }>(
        sql`select doc::text as doc, draft_doc::text as draft, draft_rev as rev
              from pages where node_id = ${id}`,
      )
    )[0]!;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    read = await import('./read');
    pages = await import('./index');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`blockrepair-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('an autosave between the read and the repair keeps the autosave', async () => {
    const id = await mkPage('autosave race');
    const seen = await seenOf(id);
    const doc = ensureBlockIds(seen.doc);
    const draft = ensureBlockIds(seen.draft!);
    expect(doc).not.toBe(seen.doc);
    expect(draft).not.toBe(seen.draft);

    // The editor's autosave lands after the read.
    const saved = await pages.saveDraft(owner, id, bare('autosaved words'));
    expect(saved.ok).toBe(true);

    expect(await read.persistBlockIdBackfill(id, seen, doc, draft)).toBe(false);
    const after = await rowText(id);
    expect(after.draft).toContain('autosaved words');
    expect(after.draft).not.toContain('draft words');
    expect(Number(after.rev)).toBe(2);
    // The published doc is untouched too: the whole write was refused.
    expect(after.doc).toContain('published words');
    expect(after.doc).not.toContain('"id"');
  });

  it('a draft written without a rev bump still beats the repair', async () => {
    const id = await mkPage('raw draft race');
    const seen = await seenOf(id);
    await x(sql`update pages set draft_doc = ${JSON.stringify(bare('raw words'))}::jsonb
                where node_id = ${id}`);
    expect(await read.persistBlockIdBackfill(id, seen, null, ensureBlockIds(seen.draft!))).toBe(
      false,
    );
    expect((await rowText(id)).draft).toContain('raw words');
  });

  it('a commit between the read and the repair keeps the commit', async () => {
    const id = await mkPage('commit race');
    const seen = await seenOf(id);
    const committed = await pages.commitPage(owner, id, bare('committed words'));
    expect(committed.ok).toBe(true);

    expect(await read.persistBlockIdBackfill(id, seen, ensureBlockIds(seen.doc), null)).toBe(false);
    const after = await rowText(id);
    expect(after.doc).toContain('committed words');
    expect(after.doc).not.toContain('published words');
  });

  it('with no edit in between the repair lands, ids in both doc and draft', async () => {
    const id = await mkPage('no race');
    const seen = await seenOf(id);
    expect(
      await read.persistBlockIdBackfill(
        id,
        seen,
        ensureBlockIds(seen.doc),
        ensureBlockIds(seen.draft!),
      ),
    ).toBe(true);
    const after = await rowText(id);
    expect(after.doc).toContain('"id"');
    expect(after.doc).toContain('published words');
    expect(after.draft).toContain('"id"');
    expect(after.draft).toContain('draft words');
    // Maintenance, not an edit: the rev stays.
    expect(Number(after.rev)).toBe(1);
  });

  it('getPage repairs a page nobody is editing (the fire-and-forget path)', async () => {
    const id = await mkPage('via getPage');
    const page = await pages.getPage(owner, id);
    expect(page?.id).toBe(id);
    let after = await rowText(id);
    for (let i = 0; i < 40 && !after.draft?.includes('"id"'); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = await rowText(id);
    }
    expect(after.draft).toContain('"id"');
    expect(after.doc).toContain('"id"');
  });
});
