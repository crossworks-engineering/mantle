/**
 * The passage-window backfill (`runChunkWindows --apply`) on a real, migrated
 * Postgres, with a fake local embedder (a stubbed fetch: no network, no
 * spend). It checks the memory-shaped parts: a one-window chunk is copied in
 * SQL from its own vector, the rest go out in small embed calls that hold
 * whole chunks, a re-run finds nothing left, and --clear removes every row.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/embeddings/src/chunk-windows.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

const DIM = 768;
const vecLiteral = (seed: number) =>
  `[${Array.from({ length: DIM }, (_, i) => ((seed * 31 + i) % 97) / 97).join(',')}]`;
// About 1.6k chars of sentences: two or three ~800-char windows.
const long = (n: number) =>
  Array.from({ length: 16 }, (_, i) => `Chunk ${n} sentence ${i} ${'word '.repeat(18)}end.`).join(
    ' ',
  );

describe.skipIf(!URL)('runChunkWindows --apply on a real database', () => {
  let m: typeof import('@mantle/db');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `cwd-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const calls: number[] = [];
  let longChunks = 0;
  let total = 0;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      calls.push(body.input.length);
      const data = body.input.map((_t, index) => ({
        index,
        embedding: Array.from({ length: DIM }, (_, i) => ((index + i) % 13) / 13),
      }));
      return new Response(JSON.stringify({ data, model: 'test/embed' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin')`;
    await admin`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`;
    await admin`insert into embedding_config
      (owner_id, model, primary_provider, primary_base_url, local_embed_batch_size)
      values (${anchor}, 'test/embed', 'local', 'http://embedder.invalid/v1', 100)`;
    const [node] = await admin`insert into nodes (owner_id, type, title, path, data)
      values (${anchor}, 'note', 'Windows test', 'notes', '{}'::jsonb) returning id`;
    // 3 one-window chunks, 7 long ones, and a long one with no vector (out of scope).
    for (let i = 0; i < 3; i++) {
      await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${anchor}, ${node!.id}, ${i}, ${`Short chunk ${i}.`}, ${vecLiteral(i)}::vector)`;
    }
    for (let i = 3; i < 10; i++) {
      await admin`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${anchor}, ${node!.id}, ${i}, ${long(i)}, ${vecLiteral(i)}::vector)`;
      longChunks++;
    }
    await admin`insert into content_chunks (owner_id, node_id, ordinal, text)
      values (${anchor}, ${node!.id}, 10, ${long(10)})`;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!admin) return;
    await admin`delete from nodes where owner_id = ${anchor}`;
    await admin`delete from embedding_config where owner_id = ${anchor}`;
    await admin`delete from spaces where login_id = ${anchor}`;
    await admin`delete from auth.users where id = ${anchor}`;
    await m.closeDb();
  });

  it('copies one-window chunks in SQL, embeds the rest in whole-chunk batches', async () => {
    const { runChunkWindows, chunkWindows } = await import('./chunk-windows');
    const perLong = chunkWindows(long(3)).length;
    expect(perLong).toBeGreaterThan(1);

    const r = await runChunkWindows(anchor, { apply: true, batch: 5, parallel: 2 });
    expect(r.chunks).toBe(10);
    expect(r.windows).toBe(3 + longChunks * perLong);
    expect(r.toEmbed).toBe(longChunks * perLong);
    expect(r.written).toBe(r.windows);
    total = r.windows;

    // Every embed call holds whole chunks and stays near the batch size.
    expect(calls.reduce((a, b) => a + b, 0)).toBe(r.toEmbed);
    for (const n of calls) {
      expect(n % perLong).toBe(0);
      expect(n).toBeLessThan(5 + perLong);
    }

    const rows = await admin`select c.ordinal, w.j,
        (w.embedding = c.embedding::halfvec(768)) as same
      from content_chunk_windows w join content_chunks c on c.id = w.chunk_id
      where w.owner_id = ${anchor} order by c.ordinal, w.j`;
    expect(rows).toHaveLength(r.windows);
    // A one-window chunk's window is its own vector; a long chunk's are new.
    for (const row of rows) expect(row.same).toBe(Number(row.ordinal) < 3);
    expect(rows.filter((x) => Number(x.ordinal) === 10)).toHaveLength(0);

    const [cfg] =
      await admin`select chunk_windows from embedding_config where owner_id = ${anchor}`;
    expect(cfg!.chunk_windows).toBe(true);
  });

  it('a re-run finds nothing left; --clear deletes every row and switches off', async () => {
    const { runChunkWindows } = await import('./chunk-windows');
    const again = await runChunkWindows(anchor, { apply: true });
    expect(again.chunks).toBe(0);
    expect(again.written).toBe(0);

    const cleared = await runChunkWindows(anchor, { clear: true });
    const [{ n }] = (await admin`select count(*)::int as n from content_chunk_windows
      where owner_id = ${anchor}`) as [{ n: number }];
    expect(n).toBe(0);
    expect(cleared.written).toBe(-total);
    const [cfg] =
      await admin`select chunk_windows from embedding_config where owner_id = ${anchor}`;
    expect(cfg!.chunk_windows).toBe(false);
  });
});
