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
import { contentChunks, contentChunkWindows, db, embeddingConfig } from '@mantle/db';
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

/**
 * The manual backfill: window rows for every embedded chunk that has none.
 * Dry run (the default) reads and plans only: counts and the estimated cost.
 * `apply` switches the brain's `chunk_windows` on FIRST (so chunks the
 * extractor writes meanwhile get windows too), then embeds page by page.
 * Resumable: a re-run skips chunks that already have windows. `clear`
 * switches it off and deletes every window row instead.
 */
export async function runChunkWindows(
  ownerId: string,
  opts: {
    apply?: boolean;
    clear?: boolean;
    pageSize?: number;
    /** Pages embedded at once (default 4). */
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
    const gone = await db
      .delete(contentChunkWindows)
      .where(eq(contentChunkWindows.ownerId, ownerId))
      .returning({ j: contentChunkWindows.j });
    return { ...empty, written: -gone.length };
  }
  const pageSize = opts.pageSize ?? 500;
  const missing = sql`not exists (select 1 from ${contentChunkWindows} w where w.chunk_id = ${contentChunks.id})`;
  const scope = and(
    eq(contentChunks.ownerId, ownerId),
    isNotNull(contentChunks.embedding),
    missing,
  );

  // Plan pass: text only, no vectors, so the dry run stays light.
  const report: ChunkWindowsReport = { ...empty };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await db
      .select({ id: contentChunks.id, text: contentChunks.text })
      .from(contentChunks)
      .where(and(scope, gt(contentChunks.id, after)))
      .orderBy(contentChunks.id)
      .limit(pageSize * 4);
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
  // A few pages in flight: each page is one embed call of a few hundred
  // windows, and the provider answers several at once. Pages are read by
  // key order, so a page in flight is never read again.
  const inFlight = new Set<Promise<void>>();
  const writePage = async (page: WindowSource[]): Promise<void> => {
    const { rows } = await chunkWindowRows(ownerId, page);
    if (rows.length === 0) return;
    // A chunk deleted meanwhile (re-extract) has no row to point at: its
    // windows are skipped rather than failing the page.
    await db.execute(sql`
      insert into ${contentChunkWindows} (chunk_id, j, owner_id, node_id, embedding)
      select v.chunk_id::uuid, v.j, v.owner_id::uuid, v.node_id::uuid, v.embedding::halfvec(768)
      from jsonb_to_recordset(${JSON.stringify(
        rows.map((r) => ({
          chunk_id: r.chunkId,
          j: r.j,
          owner_id: r.ownerId,
          node_id: r.nodeId,
          embedding: `[${r.embedding.join(',')}]`,
        })),
      )}::jsonb) as v(chunk_id text, j int, owner_id text, node_id text, embedding text)
      where exists (select 1 from ${contentChunks} c where c.id = v.chunk_id::uuid)
      on conflict do nothing`);
    report.written += rows.length;
    opts.onProgress?.(report.written, report.windows);
  };
  after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await db
      .select({
        id: contentChunks.id,
        nodeId: contentChunks.nodeId,
        text: contentChunks.text,
        embedding: contentChunks.embedding,
      })
      .from(contentChunks)
      .where(and(scope, gt(contentChunks.id, after)))
      .orderBy(contentChunks.id)
      .limit(pageSize);
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;
    const p: Promise<void> = writePage(page).finally(() => inFlight.delete(p));
    // A failed page surfaces through the race / the final wait; this only
    // keeps a page that fails after an earlier failure from going unheard.
    p.catch(() => {});
    inFlight.add(p);
    if (inFlight.size >= (opts.parallel ?? 4)) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  return report;
}

/** Switch the brain's passage windows on or off (embedding_config). */
export async function setChunkWindows(ownerId: string, on: boolean): Promise<void> {
  await db
    .update(embeddingConfig)
    .set({ chunkWindows: on, updatedAt: new Date() })
    .where(eq(embeddingConfig.ownerId, ownerId));
  clearEmbeddingModelCache(ownerId);
}
