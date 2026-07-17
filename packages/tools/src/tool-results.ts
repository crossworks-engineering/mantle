/**
 * Ephemeral tool-result spill store — the engine behind `read_result`.
 *
 * Large tool outputs (a child agent's full synthesis, a big file_read, a wide
 * search) don't belong inside the conversation: they bloat context, get
 * re-sent on every loop iteration, and historically got truncated to ~8 KB —
 * which silently dropped the very answer the model went to fetch. Instead the
 * full result is stored once (`tool_results`) and the model gets a compact
 * handle + preview; it dereferences on demand via `read_result`:
 *
 *   - page(N)   — linear slice; the crude "just read it" mode.
 *   - grep(str) — jump to substring matches with surrounding context.
 *   - query(q)  — semantic search; lazily chunks + embeds on first use
 *                 (`tool_result_chunks`), then cosine-ranks within THIS result.
 *
 * Same store-full / index-compact / dereference principle as the brain
 * (content_store ↔ content_index) and recall (archive ↔ digest). See
 * architecture §9l. Transient working state — never a `nodes` row, never seen
 * by the extractor or brain search; TTL-cleaned by age.
 */

import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db, toolResults, toolResultChunks } from '@mantle/db';
import { embed, embedBatch } from '@mantle/embeddings';

// ─── Configuration ──────────────────────────────────────────────────────────

/** Resolved byte thresholds for one tool-loop. */
export type ResultHandling = {
  /** Results at or under this go inline, untouched (the common case). */
  inlineMaxBytes: number;
  /** At or over this, the envelope recommends semantic `query`; between the
   *  two it recommends `page`/`grep`. (All modes always work regardless.) */
  embedMinBytes: number;
  /** Page size for the linear `page` mode. */
  pageBytes: number;
  /** Hard ceiling on STORED result size. A result larger than this is
   *  head-truncated (with a marker) before spilling, so one runaway tool
   *  output can't write a giant row or fan out into thousands of chunks. */
  spillMaxBytes: number;
};

/** Per-agent override shape (KB units, from `memory_config.result_handling`).
 *  Page size, max-chunks, and TTL are intentionally NOT here — they're global
 *  store policy (env), not per-agent behaviour; see the module constants
 *  below. Page size is global so the spill envelope's page count and
 *  `read_result`'s paging always agree; max-chunks is global because the
 *  `read_result` query path carries no per-agent config; TTL is store-wide
 *  retention. */
export type ResultHandlingConfig = {
  inline_max_kb?: number;
  embed_min_kb?: number;
  spill_max_kb?: number;
};

function envInt(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Global defaults — env-overridable for ops/testing. 32 KB inline is safe on
 *  today's 1M-context models with prompt caching (the re-send cost the old
 *  8 KB cap guarded against is now fractions of a cent). */
export const DEFAULT_RESULT_HANDLING: ResultHandling = {
  inlineMaxBytes: envInt('TOOL_RESULT_INLINE_MAX', 32 * 1024),
  embedMinBytes: envInt('TOOL_RESULT_EMBED_MIN', 100 * 1024),
  pageBytes: envInt('TOOL_RESULT_PAGE_BYTES', 16 * 1024),
  spillMaxBytes: envInt('TOOL_RESULT_SPILL_MAX', 1024 * 1024), // 1 MB
};

/** Max chunks embedded for the semantic tier (global). Chunk size adapts so
 *  this many chunks cover the whole stored content — so embedding cost +
 *  latency stay bounded no matter how big the (capped) result is. */
export const TOOL_RESULT_MAX_CHUNKS = envInt('TOOL_RESULT_MAX_CHUNKS', 200);

/** Retention before a spilled result is swept (global store policy). */
export const TOOL_RESULT_TTL_MS = envInt('TOOL_RESULT_TTL_DAYS', 7) * 24 * 60 * 60 * 1000;

/** Base chunk size (chars) for the semantic tier before adaptive widening. */
const BASE_CHUNK_CHARS = 1500;

/** Merge a per-agent (KB) override over the global defaults → resolved bytes. */
export function resolveResultHandling(override?: ResultHandlingConfig | null): ResultHandling {
  const kb = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1024) : undefined;
  return {
    inlineMaxBytes: kb(override?.inline_max_kb) ?? DEFAULT_RESULT_HANDLING.inlineMaxBytes,
    embedMinBytes: kb(override?.embed_min_kb) ?? DEFAULT_RESULT_HANDLING.embedMinBytes,
    // Global only — keeps the envelope's page count and read_result in sync.
    pageBytes: DEFAULT_RESULT_HANDLING.pageBytes,
    spillMaxBytes: kb(override?.spill_max_kb) ?? DEFAULT_RESULT_HANDLING.spillMaxBytes,
  };
}

// ─── Chunking (pure) ─────────────────────────────────────────────────────────

/**
 * Split text into ~maxChars windows for the semantic tier, preferring a
 * newline break near the window edge so chunks land on natural boundaries,
 * with a small overlap so a match spanning a boundary isn't lost. Pure +
 * exported for unit testing.
 */
export function chunkText(text: string, opts?: { maxChars?: number; overlap?: number }): string[] {
  const maxChars = opts?.maxChars ?? 1500;
  const overlap = Math.min(opts?.overlap ?? 150, Math.floor(maxChars / 2));
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let end = Math.min(i + maxChars, n);
    if (end < n) {
      // Prefer a newline break in the last 30% of the window.
      const windowStart = i + Math.floor(maxChars * 0.7);
      const nl = text.lastIndexOf('\n', end);
      if (nl >= windowStart) end = nl + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece) out.push(piece);
    if (end >= n) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out;
}

// ─── Handle generation ───────────────────────────────────────────────────────

function newHandle(): string {
  return `tr_${randomBytes(6).toString('hex')}`;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Head-truncate a string to at most `maxBytes` UTF-8 bytes. A split trailing
 *  codepoint is replaced by U+FFFD (Node's toString behaviour) — harmless. */
function clampToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString('utf8');
}

/** Page count for a content string at `pageBytes` per page — byte-based so it
 *  agrees with {@link readResultPage}'s byte-window slicing. */
function pageCount(content: string, pageBytes: number): number {
  return Math.max(1, Math.ceil(byteLen(content) / Math.max(1, pageBytes)));
}

/** How far past a page boundary we'll look for a newline to break on. */
const PAGE_SNAP_LOOKAHEAD = 400;

/** Snap a byte offset forward to just after the next newline (within a bounded
 *  window) so pages break on line boundaries instead of mid-word/mid-JSON.
 *  `\n` (0x0A) is ASCII and never appears inside a multibyte UTF-8 sequence, so
 *  searching for it in the byte buffer is codepoint-safe. */
function snapForwardToNewline(buf: Buffer, off: number, total: number): number {
  if (off <= 0) return 0;
  if (off >= total) return total;
  const nl = buf.indexOf(0x0a, off);
  if (nl >= 0 && nl - off <= PAGE_SNAP_LOOKAHEAD) return nl + 1;
  return off; // no nearby newline (one very long line) → raw cut
}

// ─── Spill + envelope ────────────────────────────────────────────────────────

/** Persist a full result and return its handle. */
export async function spillToolResult(args: {
  ownerId: string;
  traceId: string | null;
  toolSlug: string;
  content: string;
}): Promise<{ handle: string; bytes: number }> {
  const handle = newHandle();
  const bytes = byteLen(args.content);
  await db.insert(toolResults).values({
    id: handle,
    ownerId: args.ownerId,
    traceId: args.traceId,
    toolSlug: args.toolSlug,
    content: args.content,
    bytes,
  });
  return { handle, bytes };
}

/** The compact reference the model sees in place of a spilled result. */
export function buildResultEnvelope(args: {
  handle: string;
  toolSlug: string;
  /** The STORED content (already head-truncated if it exceeded spillMaxBytes). */
  content: string;
  /** Byte length of the stored content. */
  bytes: number;
  /** Original byte length before any ceiling truncation (== bytes if none). */
  originalBytes: number;
  handling: ResultHandling;
}): Record<string, unknown> {
  const { handle, bytes, originalBytes, content, handling } = args;
  const truncated = originalBytes > bytes; // hit the storage ceiling
  const pages = pageCount(content, handling.pageBytes);
  const previewBytes = Math.max(256, Math.floor(handling.inlineMaxBytes / 2));
  let preview = clampToBytes(content, previewBytes);
  // For a spilled result the preview is ALWAYS a strict prefix. Put an
  // unmissable cut marker IN-BAND (not just in a sibling note) so the model
  // can't mistake the preview for the whole thing — this is the main guard
  // against answering from a truncated head. It's a strong nudge, not hard
  // enforcement (which isn't possible without false positives).
  const previewTruncated = byteLen(preview) < bytes;
  if (previewTruncated) {
    preview +=
      `\n\n[⚠ PREVIEW ENDS HERE — only the first ${byteLen(preview)} of ${bytes} stored bytes are shown. ` +
      `The information you need may be past this point. Call read_result before answering.]`;
  }
  const recommend =
    bytes >= handling.embedMinBytes
      ? `This is large. Prefer read_result({handle:"${handle}", query:"<what you need>"}) for a semantic lookup; or grep/page.`
      : `Use read_result({handle:"${handle}", page:1}) to read on (${pages} pages), read_result({handle:"${handle}", grep:"<term>"}) to find a part, or read_result({handle:"${handle}", query:"<what you need>"}) for a semantic lookup.`;
  const truncNote = truncated
    ? ` NOTE: the original was ${originalBytes} bytes and was head-truncated to ${bytes} for storage — the tail is unavailable. If you need it, narrow the upstream tool call.`
    : '';
  return {
    _spilled: true,
    handle,
    tool: args.toolSlug,
    bytes,
    ...(truncated ? { original_bytes: originalBytes, truncated: true } : {}),
    pages,
    preview,
    preview_truncated: previewTruncated,
    note:
      `The full result (${bytes} bytes) was stored so it wouldn't be truncated in-context. ${recommend} ` +
      `Do NOT answer from the preview alone — it is cut off; read the relevant part first.${truncNote}`,
  };
}

/**
 * The tool-loop middleware. Small results pass through untouched; oversized
 * ones spill and return a handle envelope. Returns the string to feed back to
 * the model plus metadata for the trace step.
 */
export async function processToolResultForModel(args: {
  serialized: string;
  ownerId: string;
  traceId: string | null;
  toolSlug: string;
  handling: ResultHandling;
}): Promise<{ payload: string; spilled: boolean; handle: string | null; bytes: number }> {
  const originalBytes = byteLen(args.serialized);
  if (originalBytes <= args.handling.inlineMaxBytes) {
    return { payload: args.serialized, spilled: false, handle: null, bytes: originalBytes };
  }
  // Enforce the hard storage ceiling: head-truncate (with a marker) before
  // storing so a runaway tool output can't write a giant row or fan out into
  // an unbounded number of embedding chunks.
  let toStore = args.serialized;
  if (originalBytes > args.handling.spillMaxBytes) {
    toStore =
      clampToBytes(args.serialized, args.handling.spillMaxBytes) +
      `\n\n[… tool result head-truncated for storage: ${originalBytes} bytes original, ` +
      `${args.handling.spillMaxBytes} stored. The tail is unavailable.]`;
  }
  const { handle, bytes } = await spillToolResult({
    ownerId: args.ownerId,
    traceId: args.traceId,
    toolSlug: args.toolSlug,
    content: toStore,
  });
  const envelope = buildResultEnvelope({
    handle,
    toolSlug: args.toolSlug,
    content: toStore,
    bytes,
    originalBytes,
    handling: args.handling,
  });
  // Opportunistic, throttled cleanup so the store self-prunes even if the
  // periodic sweep isn't running — never blocks or throws.
  maybeSweep();
  return { payload: JSON.stringify(envelope), spilled: true, handle, bytes: originalBytes };
}

// ─── read_result modes ───────────────────────────────────────────────────────

type ResultRow = { content: string; bytes: number; chunked: boolean; toolSlug: string };

async function loadResult(ownerId: string, handle: string): Promise<ResultRow | null> {
  const [row] = await db
    .select({
      content: toolResults.content,
      bytes: toolResults.bytes,
      chunked: toolResults.chunked,
      toolSlug: toolResults.toolSlug,
    })
    .from(toolResults)
    .where(and(eq(toolResults.id, handle), eq(toolResults.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** Linear page (1-indexed) of `pageBytes` characters. */
export async function readResultPage(
  ownerId: string,
  handle: string,
  page: number,
  pageBytes: number,
): Promise<
  | { ok: true; page: number; pages: number; bytes: number; text: string }
  | { ok: false; error: string }
> {
  const row = await loadResult(ownerId, handle);
  if (!row) return { ok: false, error: `result '${handle}' not found or expired` };
  const size = Math.max(1, pageBytes);
  // Byte-accurate windows (consistent with the byte-based page count) snapped
  // to newline boundaries so pages don't cut mid-word / mid-JSON. Contiguous:
  // page p ends exactly where p+1 begins (both snap the same boundary).
  const buf = Buffer.from(row.content, 'utf8');
  const total = buf.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = snapForwardToNewline(buf, (p - 1) * size, total);
  const end = p === pages ? total : snapForwardToNewline(buf, p * size, total);
  const text = buf.subarray(start, Math.max(start, end)).toString('utf8');
  return { ok: true, page: p, pages, bytes: row.bytes, text };
}

/** Substring matches with surrounding context. Case-insensitive. */
export async function grepResult(
  ownerId: string,
  handle: string,
  needle: string,
  opts?: { maxMatches?: number; context?: number },
): Promise<
  | { ok: true; count: number; matches: Array<{ offset: number; snippet: string }> }
  | { ok: false; error: string }
> {
  const row = await loadResult(ownerId, handle);
  if (!row) return { ok: false, error: `result '${handle}' not found or expired` };
  const q = needle.trim();
  if (!q) return { ok: false, error: 'grep needs a non-empty term' };
  const maxMatches = opts?.maxMatches ?? 10;
  const context = opts?.context ?? 200;
  const hay = row.content.toLowerCase();
  const lo = q.toLowerCase();
  const matches: Array<{ offset: number; snippet: string }> = [];
  let from = 0;
  let count = 0;
  for (;;) {
    const idx = hay.indexOf(lo, from);
    if (idx === -1) break;
    count++;
    if (matches.length < maxMatches) {
      const s = Math.max(0, idx - context);
      const e = Math.min(row.content.length, idx + q.length + context);
      matches.push({
        offset: idx,
        snippet: (s > 0 ? '…' : '') + row.content.slice(s, e) + (e < row.content.length ? '…' : ''),
      });
    }
    from = idx + q.length;
  }
  return { ok: true, count, matches };
}

/** Ensure the result's chunks exist + are embedded (lazy). */
async function ensureResultChunked(
  ownerId: string,
  handle: string,
  content: string,
): Promise<void> {
  // Adapt chunk size so we never embed more than TOOL_RESULT_MAX_CHUNKS chunks
  // while still covering the whole stored content (coarser chunks for bigger
  // results) — bounds embedding cost + latency on the first query. The slice
  // is a hard backstop against overlap-induced overflow.
  const maxChars = Math.max(BASE_CHUNK_CHARS, Math.ceil(content.length / TOOL_RESULT_MAX_CHUNKS));
  const chunks = chunkText(content, { maxChars }).slice(0, TOOL_RESULT_MAX_CHUNKS);
  if (chunks.length === 0) {
    await db.update(toolResults).set({ chunked: true }).where(eq(toolResults.id, handle));
    return;
  }
  const vectors = await embedBatch(ownerId, chunks);
  await db.insert(toolResultChunks).values(
    chunks.map((text, i) => ({
      resultId: handle,
      ordinal: i,
      text,
      embedding: vectors[i],
    })),
  );
  await db.update(toolResults).set({ chunked: true }).where(eq(toolResults.id, handle));
}

/** Semantic search within one spilled result. Lazily chunks+embeds on first call. */
export async function queryResult(
  ownerId: string,
  handle: string,
  query: string,
  k = 5,
): Promise<
  | { ok: true; hits: Array<{ ordinal: number; text: string; distance: number }> }
  | { ok: false; error: string }
> {
  const row = await loadResult(ownerId, handle);
  if (!row) return { ok: false, error: `result '${handle}' not found or expired` };
  const q = query.trim();
  if (!q) return { ok: false, error: 'query needs non-empty text' };
  if (!row.chunked) await ensureResultChunked(ownerId, handle, row.content);

  const queryVec = await embed(ownerId, q);
  const vec = JSON.stringify(queryVec);
  const hits = await db
    .select({
      ordinal: toolResultChunks.ordinal,
      text: toolResultChunks.text,
      distance: sql<number>`${toolResultChunks.embedding} <=> ${vec}::vector`,
    })
    .from(toolResultChunks)
    .where(and(eq(toolResultChunks.resultId, handle), isNotNull(toolResultChunks.embedding)))
    .orderBy(sql`${toolResultChunks.embedding} <=> ${vec}::vector`, asc(toolResultChunks.ordinal))
    .limit(Math.min(Math.max(1, k), 20));
  return { ok: true, hits };
}

// ─── TTL cleanup ─────────────────────────────────────────────────────────────

/** Delete spilled results older than `maxAgeMs` (chunks cascade). Defaults to
 *  the global retention (env `TOOL_RESULT_TTL_DAYS`). Call from the periodic
 *  worker sweep; cheap (indexed delete) and owner-agnostic. Returns rows
 *  removed. */
export async function cleanupToolResults(maxAgeMs = TOOL_RESULT_TTL_MS): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const rows = await db
    .delete(toolResults)
    .where(sql`${toolResults.createdAt} < ${cutoff.toISOString()}`)
    .returning({ id: toolResults.id });
  return rows.length;
}

/** Throttled, fire-and-forget sweep. Called both opportunistically from the
 *  spill path (so the store self-prunes while it's being written) and from
 *  the periodic events-reminders tick (so it runs even when idle). Shares one
 *  hourly throttle across callers; never blocks the caller or throws. */
let lastSweepAt = 0;
export function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < 60 * 60 * 1000) return;
  lastSweepAt = now;
  void cleanupToolResults().catch((err) =>
    console.error(
      '[tool-results] opportunistic sweep failed:',
      err instanceof Error ? err.message : err,
    ),
  );
}
