/**
 * The extractor's lane settings against a real, migrated Postgres (0393):
 * GET and PATCH /api/embedding/extraction and the MCP tools extraction_get
 * and extraction_set read and write the one embedding_config row through
 * one reader and writer, and agree. Books at once is saved, read back with
 * its source, and cleared; the column's CHECK holds it to 1 to 4 whatever
 * writes it. Only the owner check is stubbed. Seeds its own owner and rows
 * and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run extraction-settings.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({ id: h.owner })),
}));

describe.skipIf(!URL)('the extraction lane settings on Postgres', () => {
  let m: typeof import('@mantle/db');
  let route: typeof import('./route');
  let tools: typeof import('@mantle/tools');
  const su = asSuperuser(URL);
  const owner = randomUUID();
  h.owner = owner;
  const ctx = { ownerId: owner } as never;

  const patch = (body: unknown) =>
    route.PATCH(
      new Request('http://brain.test/api/embedding/extraction', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  type Row = { book: number | null; conc: number | null; budget: number | null };
  const row = async () =>
    (
      (await su`select extraction_book_concurrency as book, extraction_concurrency as conc,
                       extraction_time_budget_minutes as budget
                  from embedding_config where owner_id = ${owner}`) as unknown as Row[]
    )[0];
  const tool = (slug: string) => tools.EXTRACTION_TOOLS.find((t) => t.slug === slug)!;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.EXTRACT_BOOK_CONCURRENCY;
    m = await import('@mantle/db');
    route = await import('./route');
    tools = await import('@mantle/tools');
    await su`insert into auth.users (id, email, password_hash, role)
             values (${owner}, ${`xs-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
    await su`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
  }, 60_000);

  afterAll(async () => {
    await su`delete from embedding_config where owner_id = ${owner}`;
    await su`delete from spaces where id = ${owner}`;
    await su`delete from auth.users where id = ${owner}`;
    await m?.closeDb();
  });

  it('before the embedder is set up: the defaults, and a save is a 409 or a refusal', async () => {
    const body = await (await route.GET()).json();
    expect(body.book_concurrency).toEqual({
      saved: null,
      effective: 1,
      source: 'default',
      default: 1,
      min: 1,
      max: 4,
    });
    expect((await patch({ book_concurrency: 2 })).status).toBe(409);
    const r = await tool('extraction_set').handler({ book_concurrency: 2 }, ctx);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Set up the embedder/) });
    expect(await row()).toBeUndefined();
  });

  it('PATCH saves books at once; GET and extraction_get read it back as saved', async () => {
    await su`insert into embedding_config (owner_id, model, primary_provider)
             values (${owner}, 'embeddinggemma', 'local')`;
    const res = await patch({ book_concurrency: 3 });
    expect(res.status).toBe(200);
    expect(await row()).toEqual({ book: 3, conc: null, budget: null });

    const body = await (await route.GET()).json();
    expect(body.book_concurrency).toMatchObject({ saved: 3, effective: 3, source: 'saved' });
    expect(body.concurrency).toMatchObject({ saved: null });

    const got = await tool('extraction_get').handler({}, ctx);
    expect(got.ok).toBe(true);
    const out = (got as { output: Record<string, unknown> }).output;
    expect(out).toMatchObject({
      configured: true,
      book_concurrency: { saved: 3, effective: 3, source: 'saved' },
    });
    expect(out.queue).toBeDefined();
  });

  it('extraction_set sets the time budget and clears books at once, leaving the count', async () => {
    await patch({ concurrency: 4 });
    const r = await tool('extraction_set').handler(
      { time_budget_minutes: 90, book_concurrency: null },
      ctx,
    );
    expect(r).toMatchObject({
      ok: true,
      output: {
        book_concurrency: { saved: null, effective: 1, source: 'default' },
        time_budget_minutes: { saved: 90, effective: 90, source: 'saved' },
        concurrency: { saved: 4, effective: 4 },
      },
    });
    expect(await row()).toEqual({ book: null, conc: 4, budget: 90 });
  });

  it('refuses a value out of range at every door, and the row stays', async () => {
    const before = await row();
    expect((await patch({ book_concurrency: 5 })).status).toBe(400);
    expect((await tool('extraction_set').handler({ book_concurrency: 5 }, ctx)).ok).toBe(false);
    await expect(
      su`update embedding_config set extraction_book_concurrency = 5 where owner_id = ${owner}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      su`update embedding_config set extraction_book_concurrency = 0 where owner_id = ${owner}`,
    ).rejects.toMatchObject({ code: '23514' });
    expect(await row()).toEqual(before);
  });
});
