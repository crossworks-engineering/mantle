/**
 * Passage windows (content_chunk_windows): extra vectors inside a retrieval
 * chunk, so a question about one sentence of a long chunk can find it.
 *
 * A chunk (~1.6k chars) is cut into sentence windows of about
 * CHUNK_WINDOW_CHARS; each window gets its own vector. Passage search matches
 * windows and returns their chunks (packages/search, the `windows` option),
 * so the text a model sees is the same chunk text as before. Measured on a
 * 122k-chunk library corpus (docs/recall-eval.md, "Passage windows"):
 * paraphrased questions had their passage in the top 50 for 29 of 40 cases
 * against 17 of 40 with chunk vectors alone; 400-char windows ranked no
 * better than 800 with twice the vectors.
 *
 * Optional per brain (`embedding_config.chunk_windows`, default off). Two
 * writers, both here: the extractor (`chunkWindowRows`, when it rebuilds a
 * node's chunks) and the manual backfill (`runChunkWindows`, the
 * `chunk-windows` maintenance task, dry run by default). No trigger, no job.
 */
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  contentChunks,
  contentChunkWindows,
  db,
  embeddingConfig,
  withDeadlockRetry,
  withHeads,
} from '@mantle/db';
import { embedBatch, resolveEmbeddingConfig, clearEmbeddingModelCache } from './index';
import { estimateEmbeddingUsd } from './reembed';

/** Target window size in characters (a window closes at the sentence that
 *  would take it past this). */
export const CHUNK_WINDOW_CHARS = 800;

/**
 * Cut a chunk's text into sentence windows (pure). Whitespace is collapsed;
 * a window closes before the sentence that would take it past `size`; one
 * sentence longer than twice `size` is cut hard; a short tail (under a third
 * of `size`) joins the window before it. A chunk of `size` chars or less is
 * one window.
 */
export function chunkWindows(text: string, size = CHUNK_WINDOW_CHARS): string[] {
  const sents = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?;:])\s+(?=["'“‘(A-Z0-9])/);
  const out: string[] = [];
  let cur = '';
  for (const s of sents) {
    if (!s) continue;
    if (cur && cur.length + s.length + 1 > size) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > size * 2) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur) {
    if (out.length && cur.length < size / 3) out[out.length - 1] += ` ${cur}`;
    else out.push(cur);
  }
  return out;
}

/** True when the brain has passage windows switched on. */
export async function chunkWindowsEnabled(ownerId: string): Promise<boolean> {
  return (await resolveEmbeddingConfig(ownerId)).chunkWindows === true;
}

export type WindowSource = {
  id: string;
  nodeId: string;
  text: string;
  /** The chunk's own vector. A one-window chunk reuses it: no embed call. */
  embedding: number[] | null;
};
export type WindowRow = typeof contentChunkWindows.$inferInsert;

/** The windows each chunk needs, and which of them must be embedded (pure). */
export function planChunkWindows(chunks: readonly WindowSource[]): {
  copies: Array<{ chunk: WindowSource }>;
  embeds: Array<{ chunk: WindowSource; j: number; text: string }>;
} {
  const copies: Array<{ chunk: WindowSource }> = [];
  const embeds: Array<{ chunk: WindowSource; j: number; text: string }> = [];
  for (const chunk of chunks) {
    if (!chunk.embedding) continue;
    const ws = chunkWindows(chunk.text);
    if (ws.length <= 1) copies.push({ chunk });
    else ws.forEach((text, j) => embeds.push({ chunk, j, text }));
  }
  return { copies, embeds };
}

/**
 * Window rows for freshly written chunks (the extractor's path). Embeds the
 * windows of multi-window chunks through the brain's own embedder, without
 * the embedding cache. Throws on an embed failure: the caller decides whether
 * that fails the rebuild.
 */
export async function chunkWindowRows(
  ownerId: string,
  chunks: readonly WindowSource[],
): Promise<{ rows: WindowRow[]; embedded: number; chars: number }> {
  const plan = planChunkWindows(chunks);
  const vectors =
    plan.embeds.length > 0
      ? await embedBatch(
          ownerId,
          plan.embeds.map((e) => e.text),
          { cache: false },
        )
      : [];
  const rows: WindowRow[] = [
    ...plan.copies.map(({ chunk }) => ({
      chunkId: chunk.id,
      j: 0,
      ownerId,
      nodeId: chunk.nodeId,
      embedding: chunk.embedding!,
    })),
    ...plan.embeds.map((e, i) => ({
      chunkId: e.chunk.id,
      j: e.j,
      ownerId,
      nodeId: e.chunk.nodeId,
      embedding: vectors[i]!,
    })),
  ];
  return {
    rows,
    embedded: plan.embeds.length,
    chars: plan.embeds.reduce((n, e) => n + e.text.length, 0),
  };
}

export type ChunkWindowsReport = {
  /** Embedded chunks with no window rows yet (the backfill's scope). */
  chunks: number;
  /** Windows those chunks need, and how many of them need an embed call. */
  windows: number;
  toEmbed: number;
  chars: number;
  estimatedUsd: number;
  model: string;
  /** Rows written (0 on a dry run). */
  written: number;
};

/** Windows per embed call in the backfill: one provider request each (the
 *  embedder's own batch is 100). A batch holds whole chunks only, so it can
 *  run a few windows over. */
export const CHUNK_WINDOW_BATCH = 100;

/** Chunks read per page (text only, never vectors). */
const READ_PAGE = 1000;

/**
 * The manual backfill: window rows for every embedded chunk that has none.
 * Dry run (the default) reads and plans only: counts and the estimated cost.
 * `apply` switches the brain's `chunk_windows` on FIRST (so chunks the
 * extractor writes meanwhile get windows too), then fills the rest.
 * Resumable: a re-run skips chunks that already have windows. `clear`
 * switches it off and deletes every window row instead.
 *
 * Memory stays flat whatever the corpus size: chunks are read as text only;
 * a one-window chunk is copied inside Postgres (its vector never reaches
 * Node); the others go out in batches of about `batch` windows, each one
 * embed call and one insert, and a batch's vectors are dropped when its
 * insert returns. Node holds at most `2 * parallel * batch` vectors
 * (`parallel` embed calls and `parallel` inserts in flight). A batch holds whole chunks, so a crash never
 * leaves a chunk half done (a half-done chunk would look done to a re-run).
 */
export async function runChunkWindows(
  ownerId: string,
  opts: {
    apply?: boolean;
    clear?: boolean;
    /** Windows per embed call (default {@link CHUNK_WINDOW_BATCH}). */
    batch?: number;
    /** Embed calls in flight (default 4). */
    parallel?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ChunkWindowsReport> {
  const config = await resolveEmbeddingConfig(ownerId);
  const empty = {
    chunks: 0,
    windows: 0,
    toEmbed: 0,
    chars: 0,
    estimatedUsd: 0,
    model: config.model,
    written: 0,
  };
  if (opts.clear) {
    await setChunkWindows(ownerId, false);
    // Heads first (workspaces plan U1, V5): one batch of nodes at a time,
    // each batch under its nodes' heads.
    let removed = 0;
    for (;;) {
      const batch = (await db.execute(
        sql`select distinct ${contentChunkWindows.nodeId} as id from ${contentChunkWindows}
             where ${contentChunkWindows.ownerId} = ${ownerId} limit 500`,
      )) as unknown as { id: string }[];
      if (batch.length === 0) break;
      const ids = batch.map((r) => r.id);
      const gone = await withDeadlockRetry(() =>
        withHeads(ids, 'update', (tx) =>
          tx.execute(
            sql`delete from ${contentChunkWindows} where ${contentChunkWindows.ownerId} = ${ownerId}
                 and ${contentChunkWindows.nodeId} = any(${`{${ids.join(',')}}`}::uuid[])`,
          ),
        ),
      );
      removed += affected(gone);
    }
    return { ...empty, written: -removed };
  }
  const batchSize = Math.max(1, opts.batch ?? CHUNK_WINDOW_BATCH);
  const parallel = Math.max(1, opts.parallel ?? 4);
  const missing = sql`not exists (select 1 from ${contentChunkWindows} w where w.chunk_id = ${contentChunks.id})`;
  const scope = and(
    eq(contentChunks.ownerId, ownerId),
    isNotNull(contentChunks.embedding),
    missing,
  );
  const readPage = (after: string) =>
    db
      .select({ id: contentChunks.id, nodeId: contentChunks.nodeId, text: contentChunks.text })
      .from(contentChunks)
      .where(and(scope, gt(contentChunks.id, after)))
      .orderBy(contentChunks.id)
      .limit(READ_PAGE);
  const FIRST = '00000000-0000-0000-0000-000000000000';

  // Plan pass: text only, no vectors, so the dry run stays light.
  const report: ChunkWindowsReport = { ...empty };
  for (let after = FIRST; ;) {
    const page = await readPage(after);
    if (page.length === 0) break;
    for (const r of page) {
      const ws = chunkWindows(r.text);
      report.chunks++;
      report.windows += Math.max(ws.length, 1);
      if (ws.length > 1) {
        report.toEmbed += ws.length;
        report.chars += ws.reduce((n, w) => n + w.length, 0);
      }
    }
    after = page[page.length - 1]!.id;
  }
  report.estimatedUsd = estimateEmbeddingUsd(report.chars, config.model);
  if (!opts.apply || report.chunks === 0) return report;

  await setChunkWindows(ownerId, true);
  const progress = (n: number) => {
    report.written += n;
    opts.onProgress?.(report.written, report.windows);
  };
  // One-window chunks: the window IS the chunk, so its vector is copied in
  // SQL (vector to halfvec) and never crosses into Node.
  // Each write takes the heads of the nodes it touches first (workspaces
  // plan U1, V5); the vectors are computed before, so a retry repeats only
  // the insert.
  const copy = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    const chunkIds = `{${ids.join(',')}}`;
    const owners = (await db.execute(
      sql`select distinct node_id as id from ${contentChunks} where id = any(${chunkIds}::uuid[])`,
    )) as unknown as { id: string }[];
    if (owners.length === 0) return;
    const res = await withDeadlockRetry(() =>
      withHeads(
        owners.map((r) => r.id),
        'update',
        (tx) =>
          tx.execute(sql`
      insert into ${contentChunkWindows} (chunk_id, j, owner_id, node_id, embedding)
      select c.id, 0, c.owner_id, c.node_id, c.embedding::halfvec(768)
      from ${contentChunks} c
      where c.id = any(${chunkIds}::uuid[]) and c.embedding is not null
      on conflict do nothing`),
      ),
    );
    progress(affected(res));
  };
  // Multi-window chunks: one insert per embed call, with a typed parameter
  // per value (no page-sized JSON string). A chunk deleted meanwhile
  // (re-extract) has no row to point at: its windows are skipped rather than
  // failing the batch.
  const write = async (items: EmbedItem[], vectors: number[][]): Promise<void> => {
    const values = items.map(
      (e, i) =>
        sql`(${e.chunkId}::uuid, ${e.j}::int, ${e.nodeId}::uuid, ${`[${vectors[i]!.join(',')}]`}::halfvec(768))`,
    );
    const nodeIds = [...new Set(items.map((e) => e.nodeId))];
    const res = await withDeadlockRetry(() =>
      withHeads(nodeIds, 'update', (tx) =>
        tx.execute(sql`
      insert into ${contentChunkWindows} (chunk_id, j, owner_id, node_id, embedding)
      select v.chunk_id, v.j, ${ownerId}::uuid, v.node_id, v.embedding
      from (values ${sql.join(values, sql`, `)}) as v(chunk_id, j, node_id, embedding)
      where exists (select 1 from ${contentChunks} c where c.id = v.chunk_id)
      on conflict do nothing`),
      ),
    );
    progress(affected(res));
  };

  // Embed calls and inserts run side by side, each up to `parallel` at once:
  // an embed call never waits for an insert (the HNSW index makes inserts
  // slow), and a batch's vectors live only until its insert returns, so Node
  // holds at most 2 x parallel batches. Chunks are read by key order, so a
  // chunk in flight is never read again. A failed job surfaces through the
  // race or the final wait; the empty catch only keeps a job that fails
  // after an earlier failure from going unheard.
  const embeds = new Set<Promise<void>>();
  const writes = new Set<Promise<void>>();
  const track = (set: Set<Promise<void>>, job: Promise<void>): void => {
    const p: Promise<void> = job.finally(() => set.delete(p));
    p.catch(() => {});
    set.add(p);
  };
  const room = async (): Promise<void> => {
    while (embeds.size >= parallel) await Promise.race(embeds);
    while (writes.size >= parallel) await Promise.race(writes);
  };
  const launch = async (items: EmbedItem[]): Promise<void> => {
    track(
      embeds,
      embedBatch(
        ownerId,
        items.map((e) => e.text),
        { cache: false },
      ).then((vectors) => track(writes, write(items, vectors))),
    );
    await room();
  };
  const launchCopy = async (ids: string[]): Promise<void> => {
    track(writes, copy(ids));
    await room();
  };
  let copies: string[] = [];
  let pending: EmbedItem[] = [];
  for (let after = FIRST; ;) {
    const page = await readPage(after);
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;
    for (const c of page) {
      const ws = chunkWindows(c.text);
      if (ws.length <= 1) {
        copies.push(c.id);
        continue;
      }
      ws.forEach((text, j) => pending.push({ chunkId: c.id, nodeId: c.nodeId, j, text }));
      if (pending.length >= batchSize) {
        const items = pending;
        pending = [];
        await launch(items);
      }
    }
    if (copies.length >= READ_PAGE) {
      await launchCopy(copies);
      copies = [];
    }
  }
  if (pending.length) await launch(pending);
  if (copies.length) await launchCopy(copies);
  // Every write is tracked by the time its embed settles.
  await Promise.all(embeds);
  await Promise.all(writes);
  return report;
}

type EmbedItem = { chunkId: string; nodeId: string; j: number; text: string };

/** Rows a write statement touched (postgres-js puts it on the result). */
function affected(res: unknown): number {
  return Number((res as { count?: number }).count ?? 0);
}

/** Switch the brain's passage windows on or off (embedding_config). */
export async function setChunkWindows(ownerId: string, on: boolean): Promise<void> {
  await db
    .update(embeddingConfig)
    .set({ chunkWindows: on, updatedAt: new Date() })
    .where(eq(embeddingConfig.ownerId, ownerId));
  clearEmbeddingModelCache(ownerId);
}
