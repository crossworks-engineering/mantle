/**
 * Extractor: content_index and retrieval-chunk writes.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIndexed, tables, contentChunks, type AiWorker } from '@mantle/db';
import { embed } from '@mantle/embeddings';
import {
  describeWorkbook,
  profileFile,
  profileToText,
  resolveStoragePath,
  schemaDigest,
  schemaToText,
} from '@mantle/tabledb';
import { step } from '@mantle/tracing';
import {
  chunkDocText,
  chunkSpreadsheetProfile,
  clampPieces,
  hasSheetMarkers,
  isSpreadsheetTitle,
} from '@mantle/content';
import { EntityMention } from './entities';

/**
 * For a file-backed table node, build the PROFILE-ONLY retrieval chunks (L1
 * profile per tab + the L2 overview + a schema data-dictionary chunk) and the
 * one-line schema digest merged into nodes.data. Returns nulls for non-table
 * nodes or when the register has no storage path / profiling fails.
 */
export async function buildTableIndexPieces(
  node: typeof nodes.$inferSelect,
  summary: string,
): Promise<{
  tableProfilePieces: { text: string; headingPath?: string }[] | null;
  tableSchemaDigest: string | null;
}> {
  // Tables v2 (§12.1 amendment, 2026-07-15): file-backed tables index
  // PROFILE-ONLY chunks — the L1 profile per tab plus the L2 overview.
  // Rows are NEVER embedded (row dumps were 531 passages/16 nodes of the
  // NATREF chunk pollution); row-level lookup is table_sql's job, and the
  // first-200-rows text lives only in tables.data_text for list ILIKE.
  // Legacy JSONB tables keep the old dataText chunking until a commit
  // converts them to file storage.
  //
  // v2.1 P3 adds the SCHEMA layer on top: a data-dictionary chunk (query
  // surface — tabs, columns, view/FTS names) so retrieval lands on schema
  // and grounds a table_sql call directly, plus a one-line digest merged
  // into nodes.data for the corpus map. Computed here, before update_index,
  // so the digest rides the same jsonb merge as the summary.
  let tableProfilePieces: { text: string; headingPath?: string }[] | null = null;
  let tableSchemaDigest: string | null = null;
  if (node.type === 'table') {
    const [reg] = await db
      .select({ storagePath: tables.storagePath })
      .from(tables)
      .where(eq(tables.nodeId, node.id))
      .limit(1);
    if (reg?.storagePath) {
      try {
        const abs = resolveStoragePath(reg.storagePath);
        const profileText = profileToText(profileFile(abs), { title: node.title });
        const surface = describeWorkbook(abs);
        tableSchemaDigest = schemaDigest(surface);
        const sections = profileText.split(/\n(?=## )/);
        tableProfilePieces = [
          {
            text: `${sections[0] ?? ''}\n\nOverview: ${summary}`.trim(),
            headingPath: 'profile',
          },
          {
            text: schemaToText(surface, {
              title: node.title,
              nodeId: node.id,
              description:
                typeof (node.data as Record<string, unknown>)?.description === 'string'
                  ? ((node.data as Record<string, unknown>).description as string)
                  : undefined,
            }),
            headingPath: 'schema',
          },
          ...sections.slice(1).map((s) => ({
            text: s.trim(),
            headingPath: `profile > ${(/^## ([^\n—]+)/.exec(s)?.[1] ?? 'tab').trim()}`,
          })),
        ].filter((p) => p.text.length > 0);
      } catch (err) {
        console.error(
          `[extractor] table profile failed for ${node.id} — falling back to dataText chunks:`,
          err,
        );
      }
    }
  }
  return { tableProfilePieces, tableSchemaDigest };
}

/**
 * content_index pass: embed (title + summary) then write the summary,
 * summary_model, entities, optional persisted full text + schema digest, and
 * the embedding onto the LIVE node row under the mid-extract concurrency guard
 * (the captured xmin). Announces the fresh index on `node_indexed`. Throws if
 * the embedder fails (retry rather than half-index) or if the row changed
 * mid-flight (stale write aborted).
 */
export async function writeContentIndex(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  worker: AiWorker,
  summary: string,
  uniqueMentions: EntityMention[],
  persistedText: string | undefined,
  tableSchemaDigest: string | null,
  rowVersion: string | null,
): Promise<void> {
  // Embed against title + summary. The summary already condenses the
  // full body (after head+tail truncation), so it's a faithful
  // representation regardless of how long the original was.
  // Previously we appended `body.slice(0, 500)` here, which gave
  // long emails / PDFs an embedding biased toward the first ~500
  // chars (lede only) and made vector search find them by greeting,
  // not by content. The summary is what we want indexed.
  const embedText = [node.title, summary].filter(Boolean).join('\n\n');
  let embedding: number[] | null = null;
  try {
    embedding = await embed(ownerId, embedText);
  } catch (err) {
    // Throw, don't half-index: writing the summary without its embedding
    // left the node invisible to vector search with no sweep that could
    // see it (the extractor_run trace excluded it from the missed-
    // extraction sweep). The queue retries with backoff; persistent
    // embedder outages land in the DLQ, which is re-driven on restart
    // and surfaced by /debug/integrity.
    throw new Error(
      `extractor: embed failed for node ${node.id} — retrying instead of half-indexing: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
  }

  await step(
    { name: 'update_index', kind: 'db_write', input: { entities: uniqueMentions.length } },
    async (h) => {
      // MERGE onto the LIVE row (jsonb `||`), not a spread of the
      // in-memory `existingData` captured at function start. For image
      // nodes, visionIngestImageNode ran in between and persisted
      // `data.vision_model` (+ `data.text`); a replacing write keyed off
      // the stale snapshot dropped vision_model (file-ingestion.md V2).
      // The merge preserves any key written after the snapshot while
      // still overwriting the index fields below.
      const indexPatch: Record<string, unknown> = {
        summary,
        summary_model: worker.model,
        summary_at: new Date().toISOString(),
        entities: uniqueMentions.map((m) => m.name),
        ...(persistedText ? { text: persistedText } : {}),
        ...(tableSchemaDigest ? { schemaDigest: tableSchemaDigest } : {}),
      };
      // Conditional on the xmin captured before the LLM call: if anything
      // wrote to this node mid-extract (a user edit being the case that
      // matters — its summary/embedding invalidation must win over our
      // now-stale output), write nothing and throw. pg-boss retries the
      // job against the fresh row; the edit's own notify coalesces with
      // it under the queue's short policy.
      const updated = await db
        .update(nodes)
        .set({
          data: sql`${nodes.data} || ${JSON.stringify(indexPatch)}::jsonb`,
          ...(embedding ? { embedding } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(nodes.id, node.id), rowVersion ? sql`xmin::text = ${rowVersion}` : sql`true`))
        .returning({ id: nodes.id });
      if (updated.length === 0) {
        throw new Error(
          `extractor: node ${node.id} changed while extraction was in flight — aborting stale write (retry re-reads)`,
        );
      }
      h.setMeta({
        summaryLength: summary.length,
        embedded: !!embedding,
        textStored: persistedText?.length ?? 0,
      });
    },
  );

  // The summary + embedding are now on the row. Announce it on the
  // reader-only `node_indexed` channel so live UI (the files screen) paints
  // the summary the instant it lands — no manual refresh. Not `node_ingested`
  // (that drives the extractor and would re-index our own output).
  await notifyNodeIndexed(node.id);

  console.log(
    `[extractor]   → content_index: summary (${summary.length}c), ${uniqueMentions.length} entities`,
  );
}

/**
 * chunked retrieval index: rebuild this node's retrieval chunks
 * (delete-for-node, then insert) so re-extracts REPLACE rather than accumulate.
 * Long docs become section-sized individually-embedded chunks; spreadsheets get
 * profile-only chunks; file-backed tables use the pre-built profile pieces.
 * Embeds BEFORE touching the table and swaps delete+insert in one transaction,
 * so an embed hiccup throws with the old chunks intact.
 */
export async function writeRetrievalChunks(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  rawBody: string,
  tableProfilePieces: { text: string; headingPath?: string }[] | null,
): Promise<void> {
  // Rebuild this node's retrieval chunks (delete-for-node, then insert)
  // so re-extracts REPLACE rather than accumulate. Long docs become
  // section-sized, individually-embedded chunks; short ones a single
  // whole-body chunk — uniform chunk-level search across all content.
  //
  // Spreadsheets are the exception: embedding a flattened grid row-by-row
  // poisons passage retrieval (a corpus audit found grid chunks at 74% of
  // one brain's chunk table, riding into the responder's auto-context as
  // numeric noise). A grid file gets one PROFILE chunk per sheet — name,
  // header row, sampled rows, honest coverage note — while the full text
  // stays readable via file_read (data.text persists above).
  const gridProfile =
    node.type === 'file' && (isSpreadsheetTitle(node.title) || hasSheetMarkers(rawBody));
  await step(
    {
      name: 'write_chunks',
      kind: 'compute',
      input: { bodyChars: rawBody.length, gridProfile },
    },
    async (h) => {
      // Embed BEFORE touching the table, and swap delete+insert in one
      // transaction. The old order (delete → embed → insert, embed
      // failure swallowed) left the node permanently chunk-less when the
      // embedder hiccuped: the delete had already run, the failure
      // returned "success", and the skip guard kept every retry away.
      // Now an embed failure throws (queue retries, old chunks intact)
      // and a crash mid-step can never destroy the previous rebuild.
      const pieces = clampPieces(
        tableProfilePieces ??
          (gridProfile
            ? chunkSpreadsheetProfile(rawBody, { fileTitle: node.title })
            : chunkDocText(rawBody)),
      );
      if (pieces.length === 0) {
        await db.delete(contentChunks).where(eq(contentChunks.nodeId, node.id));
        h.setOutput({ chunks: 0 });
        return;
      }
      const { embedBatch } = await import('@mantle/embeddings');
      const vectors = await embedBatch(
        ownerId,
        pieces.map((p) => p.text),
      );
      await db.transaction(async (tx) => {
        await tx.delete(contentChunks).where(eq(contentChunks.nodeId, node.id));
        await tx.insert(contentChunks).values(
          pieces.map((p, i) => ({
            ownerId,
            nodeId: node.id,
            ordinal: i,
            headingPath: p.headingPath ?? null,
            text: p.text,
            embedding: vectors[i] ?? null,
          })),
        );
      });
      h.setOutput({ chunks: pieces.length });
    },
  );
}
