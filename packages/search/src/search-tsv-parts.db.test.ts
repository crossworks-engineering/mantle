/**
 * nodes.search_tsv from chosen parts, each one capped (migration 0388, task
 * 05eead0e), on a real migrated Postgres:
 *
 *  - a node with 2 MB of text saves (insert and update); before 0388 the
 *    update failed with 54000 "string is too long for tsvector";
 *  - its title (A), summary (B) and a small field (C) are found by keyword
 *    search, and so is a word early in its text (D);
 *  - a word only in the text past the cap is not in nodes.search_tsv, and
 *    is found through the passages (content_chunks);
 *  - the worst input (hyphenated pairs of distinct 4-byte letters, about
 *    7.5 bytes of tsvector a character) filling every cap stays under the
 *    1 MB limit of a tsvector, and saves; the old expression fails on it.
 *
 * Seeds its own rows on the shared anchor and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/search/src/search-tsv-parts.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The limit Postgres checks: the bytes of a tsvector's lexemes and their
 *  positions (MAXSTRPOS, 2^20 - 1). */
const TSV_LIMIT = 1_048_575;

/** The caps of 0388, in characters. */
const CAP = { title: 5_000, summary: 15_000, small: 20_000, text: 90_000 };

/** Distinct letters of 4 bytes in UTF-8 (CJK extensions B to G), then of 3
 *  bytes (CJK, extension A, Hangul), in that order: the worst input takes
 *  them first. */
function worstLetters(): string[] {
  const ranges: Array<[number, number]> = [
    [0x20000, 0x2a6df],
    [0x2a700, 0x2b739],
    [0x2b820, 0x2cea1],
    [0x2ceb0, 0x2ebe0],
    [0x30000, 0x3134a],
    [0x4e00, 0x9fff],
    [0x3400, 0x4dbf],
    [0xac00, 0xd7a3],
  ];
  const out: string[] = [];
  for (const [a, b] of ranges) for (let c = a; c <= b; c++) out.push(String.fromCodePoint(c));
  return out;
}

/** `chars` characters of hyphenated pairs ("X-Y "), each letter used once:
 *  three lexemes, each with a position, from four characters. */
function worstText(letters: string[], from: { i: number }, chars: number): string {
  const words: string[] = [];
  for (let n = 0; n + 4 <= chars; n += 4) {
    words.push(`${letters[from.i]}-${letters[from.i + 1]}`);
    from.i += 2;
  }
  return words.join(' ');
}

/** A word of filler text no part of the test looks for. */
const filler = (chars: number) => {
  const words = ['pump', 'valve', 'flange', 'gasket', 'header', 'line', 'spool', 'weld'];
  const out: string[] = [];
  let n = 0;
  for (let i = 0; n < chars; i++) {
    const w = words[i % words.length]!;
    out.push(w);
    n += w.length + 1;
  }
  return out.join(' ').slice(0, chars);
};

describe.skipIf(!URL)('nodes.search_tsv from capped parts (0388)', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let s: typeof import('./index');
  let ts: typeof import('@mantle/db/test-support');
  let su: ReturnType<typeof import('@mantle/db/test-support').superuserClient>;
  let anchor = '';
  const tag = `stp${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const word = {
    title: `${tag}titleword`,
    summary: `${tag}summaryword`,
    small: `${tag}smallword`,
    early: `${tag}earlyword`,
    late: `${tag}lateword`,
    agent: `${tag}agentword`,
  };
  const big = randomUUID();
  const worst = randomUUID();
  const ids = [big, worst];
  const query = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

  /** The exact bytes Postgres checks against TSV_LIMIT, of a node's column. */
  const stringBytes = async (id: string) =>
    Number(
      (
        await su<{ b: string }[]>`
          select coalesce(sum(octet_length(t.lexeme) + octet_length(t.lexeme) % 2
                              + 2 + 2 * cardinality(t.positions)), 0)::bigint as b
            from nodes n, unnest(n.search_tsv) t where n.id = ${id}`
      )[0]!.b,
    );
  const has = async (id: string, w: string) =>
    (
      await su<{ hit: boolean }[]>`
        select search_tsv @@ plainto_tsquery('english', ${w}) as hit from nodes where id = ${id}`
    )[0]!.hit;
  const keyword = (q: string) =>
    m.asSystem(() => s.searchNodes({ ownerId: anchor, q, ids, limit: 10 }), 'test');

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    ts = await import('@mantle/db/test-support');
    m = await import('@mantle/db');
    s = await import('./index');
    su = ts.superuserClient(URL!, 1);
    anchor = await ts.ensureTestAnchor(su);
  }, 60_000);

  afterAll(async () => {
    if (su) {
      await su`delete from content_chunks where node_id = any(${`{${ids.join(',')}}`}::uuid[])`;
      await su`delete from nodes where id = any(${`{${ids.join(',')}}`}::uuid[])`;
      await su.end();
    }
    await m?.closeDb();
  });

  it('a node with 2 MB of text saves, and its title, summary, small fields and early text are found', async () => {
    await su`insert into nodes (id, owner_id, type, title, path, data)
             values (${big}, ${anchor}, 'file', ${`Book ${word.title}`}, 'files',
                     ${su.json({ filename: 'book.pdf', note: word.small })})`;
    // The text: the early word near the start, then 2 MB of filler, then
    // the late word at the very end (far past the 90,000 cap).
    const text = `Chapter one ${word.early} ${filler(2_000_000)} ${word.late} the end.`;
    expect(text.length).toBeGreaterThan(2_000_000);
    // The update the extractor makes (a merge of data), as the bug had it.
    // The Agents' text comes first in D, so a long text does not cut it off;
    // the word after a line end in it is found (its JSON escape is a space).
    const agentText = { 'agent-1': `LINE 1\n${word.agent} 150-P-101` };
    await su`update nodes set data = data || ${su.json({ text, summary: `About ${word.summary}.`, agent_text: agentText })}
             where id = ${big}`;
    const [row] = await su<{ chars: number }[]>`
      select length(data->>'text')::int as chars from nodes where id = ${big}`;
    expect(row!.chars).toBe(text.length);

    for (const w of [word.title, word.summary, word.small, word.early, word.agent]) {
      expect(await has(big, w), w).toBe(true);
      expect((await keyword(w)).map((n) => n.id)).toEqual([big]);
    }
    // Each part keeps its weight: A title, B summary, C small fields, D text.
    const weights = await su<{ lexeme: string; weights: string[] }[]>`
      select t.lexeme, t.weights from nodes n, unnest(n.search_tsv) t
       where n.id = ${big} and t.lexeme = any(${[
         word.title,
         word.summary,
         word.small,
         word.early,
       ]}::text[])`;
    expect(Object.fromEntries(weights.map((r) => [r.lexeme, r.weights]))).toEqual({
      [word.title]: ['A'],
      [word.summary]: ['B'],
      [word.small]: ['C'],
      [word.early]: ['D'],
    });
    expect(await stringBytes(big)).toBeLessThan(TSV_LIMIT);
  });

  it('a word only past the cap is not in nodes.search_tsv, and its passage finds it', async () => {
    expect(await has(big, word.late)).toBe(false);
    expect(await keyword(word.late)).toEqual([]);
    // The passage the extractor writes for the end of the text.
    await su`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
             values (${anchor}, ${big}, 0, ${`${filler(2_000)} ${word.late} the end.`},
                     ${`[${query.join(',')}]`}::vector)`;
    const hits = await m.asSystem(
      () =>
        s.searchChunks({
          ownerId: anchor,
          embedding: query,
          q: word.late,
          nodeIds: ids,
          arms: 'keyword',
          limit: 5,
        }),
      'test',
    );
    expect(hits.map((h) => h.nodeId)).toEqual([big]);
    expect(hits[0]!.text).toContain(word.late);
  });

  it('data that is no object (a JSON string, an array) saves and is found whole, at C', async () => {
    for (const data of [`${word.small}scalar note`, [`${word.small}array`, 'text'], null]) {
      const id = randomUUID();
      ids.push(id);
      // A JSON string as the whole of data is what `${JSON.stringify(x)}::jsonb`
      // makes through postgres.js (test fixtures do it); JSON null only saves.
      await su`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${anchor}, 'note', ${`${word.title}odd`}, 'notes',
                       ${JSON.stringify(data)}::text::jsonb)`;
      // The title is found whatever data holds.
      expect(await has(id, `${word.title}odd`)).toBe(true);
      if (data === null) continue;
      const w = typeof data === 'string' ? `${word.small}scalar` : `${word.small}array`;
      expect(await has(id, w), w).toBe(true);
      // The array keeps its element 'text': only an object loses its keys.
      if (Array.isArray(data)) expect(await has(id, 'text')).toBe(true);
    }
  });

  it('the worst input filling every cap stays under the limit and saves; the old expression fails on it', async () => {
    const letters = worstLetters();
    const at = { i: 0 };
    const title = worstText(letters, at, CAP.title);
    const summary = worstText(letters, at, CAP.summary);
    const small = worstText(letters, at, CAP.small + 1_000);
    // Past its cap too, so the whole blob is more than the old expression
    // can hold.
    const text = worstText(letters, at, CAP.text + 40_000) + ` ${filler(2_000_000)}`;
    expect(at.i).toBeLessThanOrEqual(letters.length);
    await su`insert into nodes (id, owner_id, type, title, path, data)
             values (${worst}, ${anchor}, 'file', ${title}, 'files',
                     ${su.json({ filename: 'worst.pdf', note: small, summary, text })})`;
    const bytes = await stringBytes(worst);
    expect(bytes).toBeLessThan(TSV_LIMIT);
    // A real worst case: within 15% of the limit, not a soft one.
    expect(bytes).toBeGreaterThan(0.85 * TSV_LIMIT);
    // The old expression (0000_init: the whole data blob at B) cannot hold it.
    await expect(
      su`select setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(data::text, '')), 'B')
           from nodes where id = ${worst}`,
    ).rejects.toMatchObject({ code: '54000' });
  }, 120_000);
});
