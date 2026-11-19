/**
 * A book of 1M characters saves through the real extractor (task 05eead0e,
 * migration 0388): extractNode writes data.text (the full text, up to
 * TEXT_STORE_MAX_CHARS) with the summary in one update, which regenerates
 * nodes.search_tsv; before 0388 that update failed with 54000 "string is
 * too long for tsvector" and the text, summary and passages were lost.
 *
 *  - an OCR-like book (a seeded mix of words, numbers, codes and the noise
 *    a scan reader leaves): the save succeeds, the passages are written,
 *    search_tsv stays under the 1 MB limit;
 *  - the worst case of 1M characters, every token distinct: the same.
 *
 * The parser is faked at the fetch (its /text answers the book), the model
 * is a fake chat adapter, and the embedder gives each text a vector. The
 * rows and the chunks are real. A migrated scratch database, dropped after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/big-text-save.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import { TEXT_STORE_MAX_CHARS } from './text';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIM = 768;
/** The limit Postgres checks: the bytes of a tsvector's lexemes and their
 *  positions (MAXSTRPOS, 2^20 - 1). */
const TSV_LIMIT = 1_048_575;

const h = vi.hoisted(() => ({ book: '' }));

vi.mock('@mantle/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/embeddings')>();
  const vec = (text: string) =>
    Array.from({ length: DIM }, (_, k) => (k === (text.length % (DIM - 1)) + 1 ? 1 : 0));
  return {
    ...actual,
    embed: async (_o: string, text: string) => vec(text),
    embedBatch: async (_o: string, texts: string[]) => texts.map(vec),
    chunkWindowsEnabled: async () => false,
  };
});
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => ({
    text: JSON.stringify({
      summary: 'A long maintenance manual for the plant.',
      entities: [],
      facts: [],
      relations: [],
    }),
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

/** A seeded generator, so a run is the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `chars` characters of what a scan reader makes of a long manual: words
 *  of a big vocabulary, numbers and tag codes (many of them distinct), with
 *  its noise: letters read wrong (rn for m, 1 for l, 0 for o...), stray
 *  marks, words cut at a line end, page headers. Tuned so the whole book,
 *  as one tsvector, is just past the limit, as the books that failed were
 *  (measured on pg18; see the first test). */
function ocrBook(chars: number): string {
  const r = rng(388);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const syllables =
    'ab ac ad al an ar as at be ca ce co de di do en er es fa fi ga ge in is la le li lo ma me mi mo na ne no or pa pe po ra re ri ro sa se si so ta te ti to tra un va ve vi'.split(
      ' ',
    );
  const vocab = Array.from({ length: 60_000 }, () =>
    Array.from({ length: 2 + Math.floor(r() * 3) }, () => pick(syllables)).join(''),
  );
  const misread: Array<[RegExp, string]> = [
    [/m/, 'rn'],
    [/rn/, 'm'],
    [/l/, '1'],
    [/o/, '0'],
    [/e/, 'c'],
    [/h/, 'b'],
    [/i/, 'l'],
    [/s/, '5'],
    [/a/, 'o'],
  ];
  const noisy = (w: string) => {
    if (r() >= 0.3) return w;
    const [from, to] = pick(misread);
    return w.replace(from, to);
  };
  const tags = ['P', 'V', 'HX', 'TK', 'PSV', 'FT', 'LT'];
  const parts: string[] = [];
  let n = 0;
  let page = 1;
  while (n < chars) {
    const p = r();
    let tok: string;
    if (p < 0.55) tok = noisy(pick(vocab));
    else if (p < 0.72) tok = `${Math.floor(r() * 100000)}.${Math.floor(r() * 100)}`;
    else if (p < 0.88) tok = `${pick(tags)}-${Math.floor(r() * 99999)}${pick(['', 'A', 'B'])}`;
    else if (p < 0.92) tok = pick(['|', '~', '»', '—', '.,', "''", '¦', ';', ':']);
    else if (p < 0.97) tok = `${noisy(pick(vocab))}${pick([',', '.', ';', ''])}`;
    else if (p < 0.995) tok = `${pick(vocab).slice(0, 3)}-\n${pick(vocab)}`;
    else tok = `\n\nPage ${page++} of 900\n`;
    parts.push(tok);
    n += tok.length + 1;
  }
  // Ends on a mark, not a space or a line end (the read text is trimmed).
  return `${parts.join(' ').slice(0, chars - 1)}.`;
}

/** `chars` characters in which no token comes twice: hyphenated pairs of
 *  distinct codes (each pair makes three lexemes, each with a position). */
function distinctBook(chars: number): string {
  const parts: string[] = [];
  let n = 0;
  for (let i = 0; n < chars; i += 2) {
    const tok = `q${i.toString(36)}-q${(i + 1).toString(36)}`;
    parts.push(tok);
    n += tok.length + 1;
  }
  // Ends on a mark, not a space or a line end (the read text is trimmed).
  return `${parts.join(' ').slice(0, chars - 1)}.`;
}

describe.skipIf(!URL)('a book of 1M characters saves through the extractor', () => {
  type Db = typeof import('@mantle/db');
  type Files = typeof import('@mantle/files');
  let m: Db;
  let f: Files;
  let extractNode: typeof import('../extractor').extractNode;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-big-text-'));

  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  const upload = (name: string) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: 'files',
        filename: name,
        bytes: Buffer.from(`PK${randomUUID()}`),
      }),
    );

  /** What the save left: the text, the summary, the stamp, the passages and
   *  the bytes of search_tsv that Postgres checks against the limit. */
  const saved = async (id: string) =>
    (
      await x<{
        chars: number;
        summary: string | null;
        completed: string | null;
        chunks: number;
        tsv: string;
      }>(sql`
        select length(n.data->>'text')::int as chars,
               n.data->>'summary' as summary,
               n.data->>'extract_completed_at' as completed,
               (select count(*)::int from content_chunks c where c.node_id = n.id) as chunks,
               (select coalesce(sum(octet_length(t.lexeme) + octet_length(t.lexeme) % 2
                                    + 2 + 2 * cardinality(t.positions)), 0)::text
                  from unnest(n.search_tsv) t) as tsv
          from nodes n where n.id = ${id}`)
    )[0]!;

  /** The whole book as one tsvector, as the 0000 expression made it:
   *  'fits', or the error's code. */
  const wholeBook = () =>
    su(sql`select to_tsvector('english', ${h.book}) is not null as ok`).then(
      () => 'fits',
      (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code,
    );

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
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
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const route = new globalThis.URL(String(url)).pathname;
        if (route === '/text') return Response.json({ text: h.book });
        if (route === '/images') return Response.json({ images: [], rejected: {}, candidates: 0 });
        throw new Error(`no fake reply for ${route}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('an OCR-like book: the save succeeds, the passages are written, search_tsv stays under 1 MB', async () => {
    h.book = ocrBook(TEXT_STORE_MAX_CHARS);
    expect(h.book.length).toBe(TEXT_STORE_MAX_CHARS);
    const file = await upload(`${randomUUID().slice(0, 8)}.docx`);
    await extractNode(file.id, anchor);
    const row = await saved(file.id);
    expect(row.chars).toBe(TEXT_STORE_MAX_CHARS);
    expect(row.summary).toBe('A long maintenance manual for the plant.');
    expect(row.completed).toBeTruthy();
    expect(row.chunks).toBeGreaterThan(100);
    expect(Number(row.tsv)).toBeGreaterThan(0);
    expect(Number(row.tsv)).toBeLessThan(TSV_LIMIT);
    // Not asserted (it depends on the parser and stemmer of one Postgres): on
    // pg18 this book as one tsvector is about 1.07 MB, so before 0388 this
    // save failed with 54000 (1,096,634 bytes with the data blob's JSON).
  }, 300_000);

  it('the worst case, 1M characters with every token distinct: the same', async () => {
    h.book = distinctBook(TEXT_STORE_MAX_CHARS);
    const file = await upload(`${randomUUID().slice(0, 8)}.docx`);
    await extractNode(file.id, anchor);
    const row = await saved(file.id);
    expect(row.chars).toBe(TEXT_STORE_MAX_CHARS);
    expect(row.completed).toBeTruthy();
    expect(row.chunks).toBeGreaterThan(100);
    expect(Number(row.tsv)).toBeLessThan(TSV_LIMIT);
    // The whole book in one tsvector would not fit: the cap is what saves it.
    expect(await wholeBook()).toBe('54000');
  }, 300_000);
});
