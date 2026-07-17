/**
 * Re-embed every stored vector for one owner with a chosen model. The same
 * logic that powers `apps/web/scripts/re-embed.ts` (CLI) and the
 * `rebuildEmbeddingIndexAction` server action behind the workers form's
 * "Rebuild Index" button.
 *
 * Use case: the operator switched embedding models. The text content
 * didn't change, but the stored vectors are now in a different model's
 * space than what the responder will use at query time — cosine
 * similarity across models is meaningless, so retrieval silently
 * degrades. This walks `nodes`, `facts`, `entities`, and `content_chunks` and re-runs
 * `embed()` over every row.
 *
 * **Idempotency:** cache-keyed by (model, content_hash). Re-running with
 * the same model hits the cache for every row and writes the same
 * vectors back — free + safe. Re-running with a *different* model burns
 * embedding API calls (and that's the point).
 *
 * **Concurrency guard:** if a rebuild is already in flight for an owner,
 * subsequent calls return the same promise. Prevents double-click +
 * multi-tab races from racing two rebuilds against each other (the
 * writes are idempotent per-row but the API spend would double).
 */

import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  contentChunks,
  db,
  entities,
  facts,
  nodes,
  type ContentChunk,
  type Entity,
  type Fact,
  type Node,
} from '@mantle/db';
import { embedBatch } from './index';

/** Tables a rebuild walks. tool_result_chunks is intentionally excluded: it's a
 *  transient spill-store (read_result) continuously regenerated and queried
 *  only within the turn that created it, so a model swap self-heals there. */
type ReembedTable = 'nodes' | 'facts' | 'entities' | 'content_chunks';

export interface ReembedOpts {
  /** Embedding model slug (OpenRouter or direct). Must be the model whose
   *  vector space you want the brain in afterwards — usually whatever
   *  `resolveEmbeddingModel(ownerId)` will return after the worker save. */
  model: string;
  /** Subset of tables to rebuild. Default: all three. */
  tables?: ReadonlyArray<ReembedTable>;
  /** Restrict by node type (only affects the nodes pass). */
  types?: string[];
  /** Repopulate mode: also embed rows whose embedding is currently NULL — used
   *  after a dimension migration that nulled the column (a same-model swap
   *  leaves vectors in place, so the default only touches already-embedded
   *  rows). For the nodes pass this embeds every node EXCEPT the kinds that
   *  never carry a vector (branch, telegram_message). Conversation digests
   *  ARE included — the summarizer embeds them at insert for find_window. */
  includeUnembedded?: boolean;
  /** Cap rows per table — useful for a smoke test. */
  limit?: number;
  /** Embed batch size. Default 50. Cache hits are free so larger batches
   *  mainly help on misses. */
  batchSize?: number;
  /** Count rows + estimate cost, write nothing. */
  dryRun?: boolean;
  /** Per-table progress callback. Fires once when a table finishes. */
  onProgress?: (event: ReembedProgressEvent) => void;
}

export type ReembedProgressEvent =
  | { kind: 'table_start'; table: ReembedTable; rows: number; chars: number }
  | { kind: 'table_done'; table: ReembedTable; written: number; durationMs: number };

export interface ReembedResult {
  byTable: Record<ReembedTable, TableResult>;
  totalRows: number;
  totalChars: number;
  totalWritten: number;
  /** Worst-case cost estimate assuming every embed was a cache miss. */
  estimatedUsdMax: number;
  durationMs: number;
  dryRun: boolean;
}

interface TableResult {
  rows: number;
  chars: number;
  written: number;
}

const DEFAULT_TABLES = ['nodes', 'facts', 'entities', 'content_chunks'] as const;
const DEFAULT_BATCH_SIZE = 50;

// In-flight rebuilds, keyed by ownerId. Coalesces double-clicks /
// multi-tab races so we don't double-spend on API calls.
const _inflight = new Map<string, Promise<ReembedResult>>();

/** Same per-1M-token estimates the CLI uses. Worst case (no cache hits). */
function estimateUsd(totalChars: number, model: string): number {
  const tokens = totalChars / 4;
  const perMillion =
    model === 'openai/text-embedding-3-small'
      ? 0.02
      : model === 'google/gemini-embedding-001'
        ? 0.15
        : model === 'google/gemini-embedding-2-preview'
          ? 0.2
          : 0.05;
  return (tokens / 1_000_000) * perMillion;
}

/** Canonical text a conversation-digest's embedding is computed from —
 *  topic label + summary, the exact surface `find_window` cosine-ranks
 *  against. The single source of truth for every digest embed site: the
 *  summarizer (insert time), this re-embed walk (model swaps), and the
 *  backfill script. */
export function digestEmbedText(label: string, summary: string): string {
  return `${label}\n${summary}`;
}

/** Digest-aware row→text for the re-embed walk. Conversation digests use
 *  the canonical digestEmbedText composition so a model swap keeps their
 *  vectors consistent with insert-time ones; everything else uses the
 *  extractor-like shape (title + summary carry the bulk of the semantic
 *  signal; re-embed predictability beats perfect parity). */
function textForNode(row: Node): string {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const isDigest =
    data.kind === 'conversation_digest' ||
    ((row.tags ?? []) as string[]).includes('conversation-digest');
  if (isDigest) {
    const topic = typeof data.topic === 'string' ? data.topic.trim() : '';
    const summary =
      typeof data.summary === 'string' && data.summary.trim()
        ? data.summary.trim()
        : typeof data.content === 'string'
          ? (data.content as string).trim()
          : '';
    if (topic && summary) return digestEmbedText(topic, summary);
    if (summary) return summary;
    return row.title;
  }
  const summary = typeof data.summary === 'string' ? data.summary : '';
  const content = typeof data.content === 'string' ? (data.content as string).slice(0, 500) : '';
  return [row.title, summary, content].filter(Boolean).join('\n\n');
}
function textForFact(row: Fact): string {
  return row.content;
}
function textForEntity(row: Entity): string {
  return `${row.kind}: ${row.name}`;
}

async function reEmbedTable<T extends { id: string }>(opts: {
  ownerId: string;
  label: ReembedTable;
  fetcher: () => Promise<T[]>;
  textFor: (row: T) => string;
  writer: (id: string, vec: number[]) => Promise<void>;
  model: string;
  batchSize: number;
  dryRun: boolean;
  onProgress?: ReembedOpts['onProgress'];
}): Promise<TableResult> {
  const start = Date.now();
  const rows = await opts.fetcher();
  const chars = rows.reduce((s, r) => s + opts.textFor(r).length, 0);
  opts.onProgress?.({ kind: 'table_start', table: opts.label, rows: rows.length, chars });

  if (opts.dryRun || rows.length === 0) {
    opts.onProgress?.({
      kind: 'table_done',
      table: opts.label,
      written: 0,
      durationMs: Date.now() - start,
    });
    return { rows: rows.length, chars, written: 0 };
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += opts.batchSize) {
    const slice = rows.slice(i, i + opts.batchSize);
    const texts = slice.map(opts.textFor);
    const vectors = await embedBatch(opts.ownerId, texts, { model: opts.model });
    for (let j = 0; j < slice.length; j++) {
      const id = slice[j]!.id;
      const vec = vectors[j];
      if (!vec) continue;
      await opts.writer(id, vec);
      written++;
    }
  }
  opts.onProgress?.({
    kind: 'table_done',
    table: opts.label,
    written,
    durationMs: Date.now() - start,
  });
  return { rows: rows.length, chars, written };
}

export async function runReembed(ownerId: string, opts: ReembedOpts): Promise<ReembedResult> {
  // Key the in-flight slot on (ownerId, model, dryRun). Coalescing two
  // calls with the same model is the whole point — it stops double-click
  // / multi-tab waste. But two concurrent calls with DIFFERENT models
  // would have aliased to the same slot and silently shared the first
  // one's promise, returning vectors from the wrong model's space —
  // the audit-caught footgun the model component fixes.
  const cacheKey = `${ownerId}:${opts.model}:${opts.dryRun ? 'dry' : 'live'}`;
  const existing = _inflight.get(cacheKey);
  if (existing) return existing;
  const promise = _runReembedInner(ownerId, opts).finally(() => {
    _inflight.delete(cacheKey);
  });
  _inflight.set(cacheKey, promise);
  return promise;
}

async function _runReembedInner(ownerId: string, opts: ReembedOpts): Promise<ReembedResult> {
  const start = Date.now();
  const tables = new Set(opts.tables ?? DEFAULT_TABLES);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? null;
  const types = opts.types ?? null;
  const includeUnembedded = opts.includeUnembedded ?? false;

  const byTable: ReembedResult['byTable'] = {
    nodes: { rows: 0, chars: 0, written: 0 },
    facts: { rows: 0, chars: 0, written: 0 },
    entities: { rows: 0, chars: 0, written: 0 },
    content_chunks: { rows: 0, chars: 0, written: 0 },
  };

  if (tables.has('nodes')) {
    const conds: SQL[] = [eq(nodes.ownerId, ownerId)];
    if (includeUnembedded) {
      // Repopulation: embed every node that SHOULD carry a vector regardless
      // of current null state — excluding the kinds that never do. Digests
      // are included since 2026-06-10 (the summarizer embeds them at insert
      // for find_window), so a dimension migration repopulates them too.
      conds.push(sql`${nodes.type}::text not in ('branch','telegram_message')`);
    } else {
      conds.push(isNotNull(nodes.embedding));
    }
    if (types && types.length > 0) {
      conds.push(sql`${nodes.type}::text = any(${types}::text[])`);
    }
    byTable.nodes = await reEmbedTable<Node>({
      ownerId,
      label: 'nodes',
      model: opts.model,
      batchSize,
      dryRun,
      onProgress: opts.onProgress,
      fetcher: async () => {
        const q = db
          .select()
          .from(nodes)
          .where(and(...conds));
        const rows = limit ? await q.limit(limit) : await q;
        return rows as Node[];
      },
      textFor: textForNode,
      writer: async (id, vec) => {
        await db
          .update(nodes)
          .set({ embedding: vec, updatedAt: new Date() })
          .where(eq(nodes.id, id));
      },
    });
  }

  if (tables.has('facts')) {
    byTable.facts = await reEmbedTable<Fact>({
      ownerId,
      label: 'facts',
      model: opts.model,
      batchSize,
      dryRun,
      onProgress: opts.onProgress,
      fetcher: async () => {
        const q = db
          .select()
          .from(facts)
          .where(
            and(
              eq(facts.ownerId, ownerId),
              isNull(facts.validTo),
              ...(includeUnembedded ? [] : [isNotNull(facts.embedding)]),
            ),
          );
        const rows = limit ? await q.limit(limit) : await q;
        return rows as Fact[];
      },
      textFor: textForFact,
      writer: async (id, vec) => {
        await db
          .update(facts)
          .set({ embedding: vec, updatedAt: new Date() })
          .where(eq(facts.id, id));
      },
    });
  }

  if (tables.has('entities')) {
    byTable.entities = await reEmbedTable<Entity>({
      ownerId,
      label: 'entities',
      model: opts.model,
      batchSize,
      dryRun,
      onProgress: opts.onProgress,
      fetcher: async () => {
        const q = db
          .select()
          .from(entities)
          .where(
            and(
              eq(entities.ownerId, ownerId),
              ...(includeUnembedded ? [] : [isNotNull(entities.embedding)]),
            ),
          );
        const rows = limit ? await q.limit(limit) : await q;
        return rows as Entity[];
      },
      textFor: textForEntity,
      writer: async (id, vec) => {
        await db
          .update(entities)
          .set({ embedding: vec, updatedAt: new Date() })
          .where(eq(entities.id, id));
      },
    });
  }

  if (tables.has('content_chunks')) {
    // search_chunks is the primary long-document retrieval primitive; leaving
    // chunk vectors in the old model's space after a rebuild is the split-brain
    // the rest of this walk exists to prevent. Chunks carry their own `text`.
    byTable.content_chunks = await reEmbedTable<ContentChunk>({
      ownerId,
      label: 'content_chunks',
      model: opts.model,
      batchSize,
      dryRun,
      onProgress: opts.onProgress,
      fetcher: async () => {
        const q = db
          .select()
          .from(contentChunks)
          .where(
            and(
              eq(contentChunks.ownerId, ownerId),
              ...(includeUnembedded ? [] : [isNotNull(contentChunks.embedding)]),
            ),
          );
        const rows = limit ? await q.limit(limit) : await q;
        return rows as ContentChunk[];
      },
      textFor: (row) => row.text,
      writer: async (id, vec) => {
        await db.update(contentChunks).set({ embedding: vec }).where(eq(contentChunks.id, id));
      },
    });
  }

  const totalRows =
    byTable.nodes.rows + byTable.facts.rows + byTable.entities.rows + byTable.content_chunks.rows;
  const totalChars =
    byTable.nodes.chars +
    byTable.facts.chars +
    byTable.entities.chars +
    byTable.content_chunks.chars;
  const totalWritten =
    byTable.nodes.written +
    byTable.facts.written +
    byTable.entities.written +
    byTable.content_chunks.written;

  return {
    byTable,
    totalRows,
    totalChars,
    totalWritten,
    estimatedUsdMax: estimateUsd(totalChars, opts.model),
    durationMs: Date.now() - start,
    dryRun,
  };
}
