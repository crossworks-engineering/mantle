/**
 * Re-fold and re-chunk (workspaces plan 5.3, phase W2; hand-run only).
 *
 * Since always fold, a page's doc_text, a drawing's scene_text and every
 * chunk hold the item's own words and a plain marker per embed. Rows written
 * before that may still hold an embed's words. This task rewrites them once,
 * for every page, note and drawing of the brain that embeds anything (or that
 * the 0247 mark flagged):
 *
 *  - doc_text (pages) and scene_text (drawings), recomputed with markers;
 *  - the chunks (and passage windows, when they are on), re-chunked from
 *    that text and embedded on the brain's embedder, which must be LOCAL
 *    unless the operator says otherwise;
 *  - for a marked row (its old summary moved to node_mixed_summaries), the
 *    node vector, from the title and the start of its own text.
 *
 * Nothing else: no summary, no facts, no model call, no extractor notify, no
 * queue job. updated_at is kept (mantle.keep_updated_at), so the extractor's
 * safety nets never read a re-folded row as edited. Each row is written in
 * its own transaction with its head locked first (plan U1). The row is read
 * again under that lock: one that changed since it was read (an edit, a new
 * chunk set) is left for the next run. Resumable: a row whose text and
 * chunks already match is skipped. Dry run by default.
 *
 * Candidates are found by their content as well as by node_embeds: an embed
 * whose item was deleted has no edge any more, but its words may still sit in
 * the host's stored text (mantle_embed_host, migration 0248).
 */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  contentChunks,
  contentChunkWindows,
  db,
  draws,
  nodes,
  pages,
  withDeadlockRetry,
  withHeads,
} from '@mantle/db';
import {
  chunkDocText,
  clampPieces,
  drawSceneText,
  foldNoteEmbeds,
  itemLevel,
} from '@mantle/content';
import { pageDocText } from '@mantle/content/pages';

type Kind = 'page' | 'note' | 'draw';
const KINDS: readonly Kind[] = ['page', 'note', 'draw'];

export interface RefoldDeps {
  /** One vector per text, in order (the brain's embedder). */
  embedBatch: (ownerId: string, texts: string[]) => Promise<number[][]>;
  /** Passage windows (embedding_config.chunk_windows). */
  windowsEnabled: (ownerId: string) => Promise<boolean>;
  planWindows: (
    chunks: { id: string; nodeId: string; text: string; embedding: number[] | null }[],
  ) => {
    copies: Array<{ chunk: { id: string; embedding: number[] | null } }>;
    embeds: Array<{ chunk: { id: string }; j: number; text: string }>;
  };
}

export interface RefoldReport {
  apply: boolean;
  /** Pages, notes and drawings that embed something or carry the mark. */
  candidates: Record<Kind, number>;
  /** Of those, rows the 0247 mark flagged (their old summary is set aside). */
  marked: Record<Kind, number>;
  /** Rows already folded and chunked: nothing to write. */
  unchanged: number;
  /** Stored text rewritten (doc_text, scene_text). */
  textRewritten: number;
  /** Rows whose chunks are rebuilt, and the chunks written. */
  rechunked: number;
  chunks: number;
  /** Node vectors recomputed (marked rows). */
  nodeVectors: number;
  /** Texts sent to the embedder (chunks, windows, node vectors). */
  embedTexts: number;
  /** Rows with no text of their own (left as they are). */
  empty: number;
  /** Rows that changed between the read and the write: left for the next run. */
  changed: number;
}

type Q = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What one row indexes after the fold: its stored text (pages, drawings)
 *  and the body its chunks come from (as the extractor's load-body reads it). */
async function foldedRow(
  ownerId: string,
  n: typeof nodes.$inferSelect,
  q: Q = db,
): Promise<{
  stored: string | null;
  storedBefore: string | null;
  body: string;
  /** Everything the row's fold was computed from (the change check). */
  source: string;
} | null> {
  if (n.type === 'page') {
    const [p] = await q
      .select({ doc: pages.doc, docText: pages.docText })
      .from(pages)
      .where(eq(pages.nodeId, n.id))
      .limit(1);
    if (!p) return null;
    const text = await pageDocText(
      ownerId,
      itemLevel(n.audience, n.inheritedLevel, n.embeddedLevel),
      p.doc,
      q,
    );
    return {
      stored: text,
      storedBefore: p.docText ?? null,
      body: text.trim() ? text : n.title,
      source: JSON.stringify([p.doc, p.docText]),
    };
  }
  if (n.type === 'draw') {
    const [d] = await q
      .select({ scene: draws.scene, fileRefs: draws.fileRefs, sceneText: draws.sceneText })
      .from(draws)
      .where(eq(draws.nodeId, n.id))
      .limit(1);
    if (!d) return null;
    const text = drawSceneText((d.scene ?? {}) as Record<string, unknown>, d.fileRefs);
    return {
      stored: text,
      storedBefore: d.sceneText ?? null,
      body: text.trim() ? text : n.title,
      source: JSON.stringify([d.scene, d.fileRefs, d.sceneText]),
    };
  }
  // A note: its markdown is the source, nothing derived is stored. The body
  // is what load-body reads (the first non-hollow of content, text, body,
  // markdown), folded.
  const data = (n.data ?? {}) as Record<string, unknown>;
  for (const c of [data.content, data.text, data.body, data.markdown]) {
    if (typeof c === 'string' && c.trim() && c.trim() !== n.title.trim()) {
      return {
        stored: null,
        storedBefore: null,
        // eslint-disable-next-line no-control-regex -- the extractor strips NUL too
        body: foldNoteEmbeds(c).replace(/\x00/g, ''),
        source: JSON.stringify(c),
      };
    }
  }
  return null;
}

/** The row as the fold saw it: its node fields, its fold source and its chunk
 *  texts. Read again under the head lock; any difference skips the write. */
async function rowState(
  ownerId: string,
  id: string,
  q: Q,
): Promise<{
  n: typeof nodes.$inferSelect;
  folded: Awaited<ReturnType<typeof foldedRow>>;
  chunks: string[];
  key: string;
} | null> {
  const [n] = await q.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!n) return null;
  const folded = await foldedRow(ownerId, n, q);
  const chunks = (
    await q
      .select({ text: contentChunks.text })
      .from(contentChunks)
      .where(eq(contentChunks.nodeId, id))
      .orderBy(asc(contentChunks.ordinal))
  ).map((o) => o.text);
  const data = (n.data ?? {}) as Record<string, unknown>;
  const key = JSON.stringify([
    n.title,
    n.audience,
    n.inheritedLevel,
    n.embeddedLevel,
    n.derivedMixed,
    data.refolded === true,
    folded?.source ?? null,
    chunks,
  ]);
  return { n, folded, chunks, key };
}

export async function refoldEmbeds(
  ownerId: string,
  opts: { apply: boolean; limit?: number; ids?: readonly string[]; deps: RefoldDeps },
): Promise<RefoldReport> {
  const report: RefoldReport = {
    apply: opts.apply,
    candidates: { page: 0, note: 0, draw: 0 },
    marked: { page: 0, note: 0, draw: 0 },
    unchanged: 0,
    textRewritten: 0,
    rechunked: 0,
    chunks: 0,
    nodeVectors: 0,
    embedTexts: 0,
    empty: 0,
    changed: 0,
  };
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        inArray(nodes.type, [...KINDS]),
        ...(opts.ids ? [inArray(nodes.id, [...opts.ids])] : []),
        or(
          eq(nodes.derivedMixed, true),
          sql`EXISTS (SELECT 1 FROM node_embeds e WHERE e.from_id = ${nodes.id})`,
          // By content too: a deleted embed leaves no edge (0248).
          sql`public.mantle_embed_host(${nodes.id}, ${nodes.type})`,
          sql`(${nodes.type} = 'note' AND ${nodes.data}::text ~ '\\]\\((media|draw):')`,
        ),
      ),
    )
    .orderBy(asc(nodes.createdAt))
    .limit(opts.limit ?? 1_000_000);
  const windowsOn = await opts.deps.windowsEnabled(ownerId);

  for (const row of rows) {
    const kind = row.type as Kind;
    report.candidates[kind] += 1;
    if (row.derivedMixed) report.marked[kind] += 1;
    const seen = await rowState(ownerId, row.id, db);
    if (!seen) continue;
    const { n, folded } = seen;
    if (!folded) {
      report.empty += 1;
      continue;
    }
    const pieces = clampPieces(chunkDocText(folded.body));
    const old = seen.chunks;
    const textChanged = folded.stored !== null && folded.stored !== folded.storedBefore;
    const chunksChanged = old.length !== pieces.length || old.some((o, i) => o !== pieces[i]!.text);
    // A marked row needs its node vector once (data.refolded records it).
    const needsVector =
      n.derivedMixed && (n.data as Record<string, unknown> | null)?.refolded !== true;
    if (!textChanged && !chunksChanged && !needsVector) {
      report.unchanged += 1;
      continue;
    }
    if (textChanged) report.textRewritten += 1;
    if (chunksChanged) {
      report.rechunked += 1;
      report.chunks += pieces.length;
    }
    const nodeVectorText = needsVector
      ? [n.title, folded.body.slice(0, 2000)].filter(Boolean).join('\n\n')
      : null;
    if (needsVector) report.nodeVectors += 1;
    if (!opts.apply) {
      report.embedTexts += (chunksChanged ? pieces.length : 0) + (nodeVectorText ? 1 : 0);
      continue;
    }

    // The model-free work first (embeds), then one short transaction.
    const texts = [
      ...(chunksChanged ? pieces.map((p) => p.text) : []),
      ...(nodeVectorText ? [nodeVectorText] : []),
    ];
    const vecs = texts.length ? await opts.deps.embedBatch(ownerId, texts) : [];
    report.embedTexts += texts.length;
    const chunkVecs = chunksChanged ? vecs.slice(0, pieces.length) : [];
    const nodeVec = nodeVectorText ? vecs[vecs.length - 1]! : null;
    const windows: Array<{ ordinal: number; j: number; embedding: number[] }> = [];
    if (chunksChanged && windowsOn) {
      const plan = opts.deps.planWindows(
        pieces.map((p, i) => ({
          id: String(i),
          nodeId: n.id,
          text: p.text,
          embedding: chunkVecs[i] ?? null,
        })),
      );
      const wv = plan.embeds.length
        ? await opts.deps.embedBatch(
            ownerId,
            plan.embeds.map((e) => e.text),
          )
        : [];
      report.embedTexts += plan.embeds.length;
      for (const c of plan.copies) {
        windows.push({ ordinal: Number(c.chunk.id), j: 0, embedding: c.chunk.embedding! });
      }
      plan.embeds.forEach((e, k) =>
        windows.push({ ordinal: Number(e.chunk.id), j: e.j, embedding: wv[k]! }),
      );
    }

    const wrote = await withDeadlockRetry(() =>
      withHeads([n.id], 'update', async (tx) => {
        // Read again under the head: an edit or a new chunk set since the
        // read above leaves the row for the next run (W2 audit).
        const now = await rowState(ownerId, n.id, tx);
        if (!now || now.key !== seen.key) return false;
        await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
        if (textChanged && n.type === 'page') {
          await tx.update(pages).set({ docText: folded.stored! }).where(eq(pages.nodeId, n.id));
        }
        if (textChanged && n.type === 'draw') {
          await tx.update(draws).set({ sceneText: folded.stored! }).where(eq(draws.nodeId, n.id));
        }
        if (chunksChanged) {
          await tx.delete(contentChunks).where(eq(contentChunks.nodeId, n.id));
          if (pieces.length) {
            const written = await tx
              .insert(contentChunks)
              .values(
                pieces.map((p, i) => ({
                  ownerId,
                  nodeId: n.id,
                  ordinal: i,
                  headingPath: p.headingPath ?? null,
                  text: p.text,
                  embedding: chunkVecs[i] ?? null,
                })),
              )
              .returning({ id: contentChunks.id, ordinal: contentChunks.ordinal });
            if (windows.length) {
              const idOf = new Map(written.map((r) => [r.ordinal, r.id]));
              await tx.insert(contentChunkWindows).values(
                windows.map((w) => ({
                  chunkId: idOf.get(w.ordinal)!,
                  j: w.j,
                  ownerId,
                  nodeId: n.id,
                  embedding: w.embedding,
                })),
              );
            }
          }
        }
        if (nodeVec) {
          await tx
            .update(nodes)
            .set({
              embedding: nodeVec,
              data: sql`coalesce(${nodes.data}, '{}'::jsonb) || '{"refolded":true}'::jsonb`,
            })
            .where(eq(nodes.id, n.id));
        }
        return true;
      }),
    );
    if (!wrote) {
      report.changed += 1;
      if (textChanged) report.textRewritten -= 1;
      if (chunksChanged) {
        report.rechunked -= 1;
        report.chunks -= pieces.length;
      }
      if (needsVector) report.nodeVectors -= 1;
    }
  }
  return report;
}
