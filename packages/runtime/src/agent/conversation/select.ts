/**
 * The pure half of loadConversationContext: everything it decides ONCE the rows
 * are in hand.
 *
 * These transforms carry the retrieval judgement — the 0.85 fact mismatch
 * guard, the 0.6 salience-adjusted content cutoff, the chunk cutoff, which
 * entities become graph anchors, what the /debug/context snapshot shows as sent
 * versus dropped, how a superseded hit is re-pointed or dropped, and how a
 * history row is rebuilt with its media and tool-record read-backs.
 *
 * They lived inline in a 544-line function that made a dozen SQL calls, so none
 * of them had a test: reaching any one meant standing up a database. They are
 * pure functions over rows now, and select.test.ts covers them directly.
 *
 * Bodies moved verbatim (dedented). The names the bodies use are preserved as
 * the local declarations and parameters here, so the code inside is unchanged.
 */

import type { SnapshotItem } from '@mantle/client-types';
import type {
  ChunkContextHit,
  ContentHit,
  CorpusMapEntry,
  Digest,
  FactSnippet,
  HistoryTurn,
} from '../messages';
import { formatMediaRecordSuffix, formatToolRecordSuffix } from './format';

/** Snapshot text is snipped and near-miss lists capped so a snapshot stays well
 *  under the tracing layer's 64KB truncation ceiling. */
export const SNAP_SNIP = 240;
export const SNAP_DROPPED_CAP = 5;
export const snip = (s: string | null | undefined, n = SNAP_SNIP): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
export const round3 = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;

/** Entity-anchored expansion: how many of the top facts' entities to expand. */
export const RELATION_ANCHOR_LIMIT = 5;

/** Cosine cutoff for a section-level passage to be worth its tokens. */
export const CHUNK_CUTOFF = 0.65;

export type FactRow = {
  content: string;
  kind: string;
  entityId: string | null;
  entityName: string | null;
  dist: number | null;
};

export type ContentRow = {
  nodeId: string;
  title: string;
  type: string;
  data: unknown;
  supersededBy: string | null;
  dist: number | null;
};

export type ChunkSearchHit = {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  nodeSupersededBy?: string | null;
  headingPath: string | null;
  text: string;
  distance: number;
};

export type CorpusRow = {
  id: string;
  type: string;
  title: string;
  path: string | null;
  data: unknown;
};

export type HistoryRow = {
  direction: string;
  text: string;
  data: unknown;
  attachments: unknown;
};

/** Facts admitted this turn, the snapshot split, and the graph anchors. */
export function selectFacts(rows: FactRow[]): {
  facts: FactSnippet[];
  sent: SnapshotItem[];
  dropped: SnapshotItem[];
  anchorEntityIds: string[];
} {
  const factRows = rows
    // Mismatch guard: if the query vector and stored fact vectors live in
    // different embedding-model spaces, cosine distances cluster near 1.0.
    // Drop those so a mismatch degrades to "no facts" (visible) rather than
    // surfacing garbage-space rows. Loose by design (0.85) — legitimate facts
    // still pass even when only loosely related.
    .filter((r) => (r.dist ?? 1) < 0.85)
    .map((r) => ({ content: r.content, kind: r.kind as string, entityName: r.entityName }));
  const toSnapItem = (r: (typeof rows)[number]): SnapshotItem => ({
    text: snip(r.content),
    dist: round3(r.dist),
    kind: r.kind as string,
    entity: r.entityName,
  });
  const factsSentSnap = rows.filter((r) => (r.dist ?? 1) < 0.85).map(toSnapItem);
  const factsDroppedSnap = rows
    .filter((r) => (r.dist ?? 1) >= 0.85)
    .slice(0, SNAP_DROPPED_CAP)
    .map(toSnapItem);
  // Anchor entities = the entities of the top matching facts (rank order,
  // distinct), the seeds for graph expansion below.
  const ranked: string[] = [];
  for (const r of rows) {
    if ((r.dist ?? 1) >= 0.85 || !r.entityId) continue;
    if (!ranked.includes(r.entityId)) ranked.push(r.entityId);
    if (ranked.length >= RELATION_ANCHOR_LIMIT) break;
  }
  const anchorEntityIds = ranked;

  return { facts: factRows, sent: factsSentSnap, dropped: factsDroppedSnap, anchorEntityIds };
}

/** Preferences ride in every turn's prefix; prepend the ones the vector search
 *  did not already return. */
export function mergePreferences(
  factRows: FactSnippet[],
  factsSentSnap: SnapshotItem[],
  prefRows: Array<{ content: string; kind: string; entityName: string | null }>,
): { facts: FactSnippet[]; sent: SnapshotItem[] } {
  const seen = new Set(factRows.map((f) => f.content));
  const prefs = prefRows
    .filter((p) => !seen.has(p.content))
    .map((p) => ({ content: p.content, kind: p.kind as string, entityName: p.entityName }));
  if (prefs.length) {
    factRows = [...prefs, ...factRows];
    factsSentSnap = [
      ...prefs.map((p) => ({
        text: snip(p.content),
        dist: null, // always-injected, not vector-ranked
        kind: p.kind,
        entity: p.entityName,
      })),
      ...factsSentSnap,
    ];
  }

  return { facts: factRows, sent: factsSentSnap };
}

/** Content hits past the salience-adjusted cutoff, plus the snapshot split. */
export function selectContentHits(rows: ContentRow[]): {
  hits: ContentHit[];
  sent: SnapshotItem[];
  dropped: SnapshotItem[];
} {
  const contentHits = rows
    .filter((r) => (r.dist ?? 1) < 0.6) // salience-adjusted cutoff — drop non-matches + demoted bulk
    .map((r) => {
      const data = (r.data ?? {}) as Record<string, unknown>;
      // `mime_type` is the stored key (snake), not `mimeType`. An extracted
      // document image lands here as a plain `file` node, so the mime is the
      // only thing that says "this hit is a picture, and showing it is a
      // possible answer" — see ContentHit.inlineRef for why the finished
      // marker travels with it.
      const mime = typeof data.mime_type === 'string' ? data.mime_type : '';
      const isImage = mime.startsWith('image/');
      return {
        nodeId: r.nodeId,
        title: r.title,
        type: r.type as string,
        summary: typeof data.summary === 'string' ? data.summary : null,
        ...(isImage ? { inlineRef: `![${r.title}](media:${r.nodeId})` } : {}),
        ...(r.supersededBy ? { supersededBy: { id: r.supersededBy, title: '' } } : {}),
      };
    });
  const toSnapItem = (r: (typeof rows)[number]): SnapshotItem => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    return {
      text: snip(typeof data.summary === 'string' ? data.summary : ''),
      dist: round3(r.dist),
      kind: r.type as string,
      nodeId: r.nodeId,
      title: r.title,
    };
  };
  const contentSentSnap = rows.filter((r) => (r.dist ?? 1) < 0.6).map(toSnapItem);
  const contentDroppedSnap = rows
    .filter((r) => (r.dist ?? 1) >= 0.6)
    .slice(0, SNAP_DROPPED_CAP)
    .map(toSnapItem);

  return { hits: contentHits, sent: contentSentSnap, dropped: contentDroppedSnap };
}

/** Section-level passages worth their tokens, plus the snapshot split. */
export function selectChunkHits(
  hits: ChunkSearchHit[],
  chunkLimit: number,
): { hits: ChunkContextHit[]; sent: SnapshotItem[]; dropped: SnapshotItem[] } {
  const selected = hits
    .filter((h) => h.distance < CHUNK_CUTOFF && h.nodeType !== 'telegram_message')
    .slice(0, chunkLimit);
  const chunkHits = selected.map((h) => ({
    nodeId: h.nodeId,
    title: h.nodeTitle,
    heading: h.headingPath,
    text: h.text,
    ...(h.nodeSupersededBy ? { supersededBy: { id: h.nodeSupersededBy, title: '' } } : {}),
  }));
  const toSnapItem = (h: (typeof hits)[number]): SnapshotItem => ({
    text: snip(h.text),
    dist: round3(h.distance),
    nodeId: h.nodeId,
    title: h.nodeTitle,
    heading: h.headingPath,
  });
  const chunkSentSnap = selected.map(toSnapItem);
  const chunkDroppedSnap = hits
    .filter((h) => !selected.includes(h))
    .slice(0, SNAP_DROPPED_CAP)
    .map(toSnapItem);

  return { hits: chunkHits, sent: chunkSentSnap, dropped: chunkDroppedSnap };
}

/** Node ids of hits that point at a superseded node, so one batched query can
 *  resolve them all. Empty means no query at all. */
export function staleNodeIds(contentHits: ContentHit[], chunkHits: ChunkContextHit[]): string[] {
  const staleIds = [
    ...contentHits.filter((h) => h.supersededBy).map((h) => h.nodeId),
    ...chunkHits.filter((h) => h.supersededBy).map((h) => h.nodeId),
  ];
  return staleIds;
}

/** Re-point a superseded hit at its living successor. A dangling edge (the
 *  successor was deleted) DROPS the annotation rather than pointing the model
 *  at a ghost. */
export function patchSuperseded<
  T extends { nodeId: string; supersededBy?: { id: string; title: string } },
>(hits: T[], successors: Map<string, { id: string; title: string }>): T[] {
  const patch = <T extends { nodeId: string; supersededBy?: { id: string; title: string } }>(
    h: T,
  ): T => {
    if (!h.supersededBy) return h;
    const succ = successors.get(h.nodeId);
    // A dangling edge (successor deleted) drops the annotation rather
    // than pointing the model at a ghost.
    return succ
      ? { ...h, supersededBy: { id: succ.id, title: succ.title } }
      : { ...h, supersededBy: undefined };
  };
  return hits.map(patch);
}

/** The "what exists" map, capped. `rows` is fetched with limit+1 so one extra
 *  row is what proves truncation. */
export function buildCorpusMap(
  rows: CorpusRow[],
  corpusMapLimit: number,
): { entries: CorpusMapEntry[]; truncated: boolean } {
  const truncated = rows.length > corpusMapLimit;
  const corpusMap = {
    entries: rows.slice(0, corpusMapLimit).map((r) => {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const wantSummary = r.type === 'page' || r.type === 'table';
      return {
        nodeId: r.id,
        type: r.type as string,
        title: r.title,
        branch: String(r.path ?? '').split('.')[0] || 'content',
        summary: wantSummary && typeof data.summary === 'string' ? (data.summary as string) : null,
        // Tables carry a one-line schema digest (tab names + shape + leading
        // columns, written by the extractor) so the model knows what's
        // queryable via table_schema/table_sql without a tool call.
        schema:
          r.type === 'table' && typeof data.schemaDigest === 'string'
            ? (data.schemaDigest as string)
            : null,
      };
    }),
    truncated,
  };

  return corpusMap;
}

/** Digest notes, oldest first, dropping any with no summary text. */
export function buildDigests(digestRows: Array<{ data: unknown }>): Digest[] {
  const digests: Digest[] = digestRows
    .reverse()
    .map((d) => {
      const data = d.data as Record<string, unknown>;
      const topic = typeof data.topic === 'string' && data.topic.trim() ? data.topic.trim() : null;
      return {
        summary: String(data.summary ?? ''),
        periodStart: String(data.period_start ?? ''),
        periodEnd: String(data.period_end ?? ''),
        topic,
      };
    })
    .filter((d) => d.summary.length > 0);

  return digests;
}

/** Recent turns as prompt history, oldest first, with the media and
 *  tool-outcome read-backs appended. The counters feed the snapshot. */
export function buildHistory(rows: HistoryRow[]): {
  history: HistoryTurn[];
  toolRecords: number;
  mediaRecords: number;
} {
  let historyToolRecords = 0;
  let historyMediaRecords = 0;
  const history: HistoryTurn[] = rows.reverse().map((r) => {
    // Media read-back runs on BOTH directions: a picture the user uploaded is
    // as re-referenceable as one a tool produced.
    const media = formatMediaRecordSuffix(r.attachments);
    if (media) historyMediaRecords++;
    const withMedia = (text: string) => (media ? `${text}\n${media}` : text);
    if (r.direction !== 'outbound') return { role: 'user', text: withMedia(r.text) };
    // Tool-outcome read-back (context-transfer audit, dev-brain task
    // 64170cb0): the ledger of what an assistant turn actually DID — failures,
    // approval-queued calls, artifacts written — is otherwise invisible to the
    // next turn unless the reply prose restated it, which is exactly what
    // failed in the field ("Where did you update it?"). Appended only when the
    // record says something the text may not, so chat-only and read-only turns
    // cost nothing extra.
    const suffix = formatToolRecordSuffix(r.data);
    if (suffix) historyToolRecords++;
    return { role: 'assistant', text: withMedia(suffix ? `${r.text}\n${suffix}` : r.text) };
  });

  return { history, toolRecords: historyToolRecords, mediaRecords: historyMediaRecords };
}
