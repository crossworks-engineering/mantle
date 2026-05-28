/**
 * The extractor — Stage-C agent that populates content_index, facts, and
 * entities from each new content_store row.
 *
 * Triggered by pg_notify('node_ingested') from migration 0018. Per node:
 *
 *   1. Resolve the active extractor agent. Skip if none enabled.
 *   2. Skip if node type isn't in agent.memory_config.extract_types.
 *      Defence in depth: HARD_SKIP_TYPES (secret, branch) are skipped
 *      regardless of config — secrets must NEVER be summarised or fact-
 *      extracted, period.
 *   3. Read the source body (typed dispatch by node type).
 *   4. content_index pass — generate 1-2 sentence summary + embedding.
 *      Write to nodes.data.summary, nodes.data.summary_model,
 *      nodes.data.entities, and nodes.embedding.
 *   5. Fact extraction pass (if memory_config.extract_facts !== false):
 *      a. LLM call → JSON array of candidate facts (with entity mentions).
 *      b. For each candidate fact:
 *           - Embed it.
 *           - Vector-search top-3 near-existing facts.
 *           - Classifier LLM call returns ADD | UPDATE | DELETE | NOOP.
 *           - Apply: INSERT new, supersede an existing row, retire an
 *             old fact, or no-op.
 *      c. Entity reconciliation: dedup via trigram name match +
 *         embedding similarity; create new entities for misses;
 *         add 'mentioned_in' edge from entity to source node.
 *   6. Bump agent's last_used_at + usage_count.
 *
 * Stays pure-logic — no listener registration here. main.ts wires the
 * pg_notify channel to extractNode().
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  agents,
  bumpWorkerUsage,
  facts,
  entities,
  entityEdges,
  getDefaultWorker,
  nodes,
  emails,
  pages,
  contentChunks,
  type Agent,
  type AgentMemoryConfig,
  type AiWorker,
  type ExtractorParams,
  type Entity,
  type Fact,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { embed } from '@mantle/embeddings';
import { diskPathForFile, extOf, mimeForExt, parseDocumentBytes, INGESTABLE_EXTS, parserRouteForExt } from '@mantle/files';
import { currentTrace, recordSkippedTrace, startTrace, step } from '@mantle/tracing';
import {
  documentWorkerPrefersNative,
  recordChatUsage,
  runDocumentWorker,
  runVisionWorker,
} from '@mantle/agent-runtime';
import { getChatAdapter, type ChatDispatcher, type ChatResult } from '@mantle/voice';
import { chunkDocText, mentionRefs } from '@mantle/content';
import { isLikelyDifferentPerson } from './person-names';

/** Types we will NEVER extract from, no matter what the agent config says.
 *  Note `secret` is NOT here — secret nodes have metadata-only extraction
 *  (see `readNodeBody`'s special case). The encrypted value is never
 *  loaded from the `secrets` table by this file, so it physically can't
 *  leak into a prompt. */
const HARD_SKIP_TYPES = new Set(['branch']);

/** Default allowlist; per-agent override via memory_config.extract_types.
 *  `file` covers text files (.md/.txt/.json/.yaml) read via the disk
 *  fallback in readNodeBody, plus PDFs parsed through `pdf-parse`.
 *  `email` / `email_thread` cover IMAP-ingested messages — subject +
 *  bodyText are pulled from the `emails` row.
 *  `secret` is METADATA-ONLY: only title + description + tags reach the
 *  LLM. The sealed value never leaves the DB.
 *  `task` and `event` are first-class content: title + body + metadata
 *  (status, due_at, starts_at, location, …) all become part of the body
 *  the extractor summarises and embeds. */
const DEFAULT_EXTRACT_TYPES = ['note', 'page', 'file', 'email', 'email_thread', 'secret', 'task', 'event', 'contact'];

/** Max characters of body text we feed the summarizer in one shot.
 *  Long emails / PDFs get truncated to keep the prompt bounded and the
 *  cost predictable. A summary is a spine, not a full recap. */
const BODY_MAX_CHARS = 24_000;

/** Max characters of extracted text we PERSIST as `data.text` for binary
 *  file nodes (pdf/docx/xlsx) whose body isn't otherwise stored. This is
 *  the retrievable full document — independent of the prompt truncation
 *  above. Single-user/family scale, so the cap is generous; it only
 *  exists to bound a pathologically huge OCR'd file, not real documents. */
const TEXT_STORE_MAX_CHARS = 1_000_000;

/** Top-K near-neighbours considered when classifying a candidate fact. */
const CLASSIFIER_NEIGHBOURS = 3;

/** Similarity threshold for "this candidate fact looks like an existing one." */
const FACT_DEDUP_THRESHOLD = 0.30; // cosine distance; lower = more similar

/** Similarity threshold for resolving an entity mention to an existing entity. */
const ENTITY_DEDUP_THRESHOLD = 0.25;

// ─── Prompts ────────────────────────────────────────────────────────────────

export const DEFAULT_EXTRACTOR_PROMPT = `You are a memory extractor for a personal AI assistant. You will be given the title and body of a piece of content (a note, document, email, etc.) belonging to a single user. Your job is to produce TWO outputs:

1. A 1-2 sentence summary of what this content is about. Be specific — names, dates, projects, numbers. Avoid filler ("this document discusses..."). Write it as a *spine* you could read to remember what's in the document without reading the document.

2. A list of facts about the user or their world that this content reveals. Each fact is a single declarative sentence. Include the entities mentioned (people, projects, places, organisations, events) so they can be cross-referenced.

Output STRICT JSON, no markdown, no commentary outside the JSON:

{
  "summary": "<1-2 sentences>",
  "facts": [
    {
      "content": "<the fact as a sentence>",
      "kind": "factual" | "episodic" | "semantic" | "preference",
      "confidence": 0.0-1.0,
      "entities": [{ "name": "<entity>", "kind": "person" | "project" | "place" | "org" | "event" }]
    }
  ],
  "entities": [{ "name": "<entity>", "kind": "person" | "project" | "place" | "org" | "event" }]
}

Fact kinds:
- "factual" = a verifiable claim with a value ("Jason's birthday is March 4").
- "episodic" = a record of something that happened, anchored to a date ("On 2026-03-04 Jason completed a workout").
- "semantic" = a STABLE identity, and ONLY when the content clearly establishes it or there's strong repeated evidence ("Jason is a pastor"). Do NOT infer an identity from a single mundane action.
- "preference" = how the user wants to be helped, and ONLY when they EXPLICITLY state it ("Jason prefers concise replies"). Never infer a preference from one action.

Be conservative — quality over quantity:
- Extract only facts genuinely worth remembering. A single task, event, reminder, or routine action is usually just ONE episodic (or factual) fact — do not also generalise it into a semantic identity or a preference.
- If the content reveals nothing beyond what its title already says, return an empty facts array.
- Don't restate the same fact more than one way.
- Confidence: 1.0 only for explicitly stated facts; 0.6-0.8 for well-grounded inferences. If you would assign below 0.6, OMIT the fact rather than guessing.
- DO NOT extract secrets, passwords, API keys, or other credentials. Skip those entirely.`;

const CLASSIFIER_PROMPT_TEMPLATE = (candidate: string, neighbours: string[]) => `You are managing a personal memory store. A new candidate fact has been extracted from a document. You must decide how it relates to existing nearby facts.

Candidate fact:
"${candidate}"

Up to ${neighbours.length} existing facts in the store that are semantically similar:
${neighbours.map((n, i) => `[${i + 1}] "${n}"`).join('\n')}

Decide ONE of:
- ADD     — the candidate is a new fact not represented above. INSERT it.
- UPDATE  — the candidate refines or replaces an existing fact (target the index 1..${neighbours.length}). Existing fact will be marked valid_to=now and the candidate becomes its successor.
- DELETE  — the candidate contradicts an existing fact (target the index). Existing fact gets retired (valid_to=now) and we do NOT add the candidate.
- NOOP    — the candidate is essentially the same as an existing fact (target the index). Nothing to do.

Output STRICT JSON, no markdown:
{ "decision": "ADD" | "UPDATE" | "DELETE" | "NOOP", "target_index": 1..${neighbours.length} | null, "reason": "<short>" }`;

// ─── Types ──────────────────────────────────────────────────────────────────

import {
  isValidEntity,
  isValidFact,
  parseExtractorOutput,
  sanitiseFactEntities,
  type ExtractedFact,
  type ExtractorOutput,
} from './extractor-parse';

type ClassifierDecision = {
  decision: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  target_index: number | null;
  reason?: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolveExtractor(ownerId: string): Promise<AiWorker | null> {
  return await getDefaultWorker(ownerId, 'extractor');
}

/** Bound the body the LLM sees. Keeps head + tail so the model gets both
 *  the lede and the sign-off (which often carries the most action items in
 *  long emails). The FULL raw text is persisted separately (see
 *  `data.text` in the index pass) — this truncation is prompt-only. */
function truncateForPrompt(body: string): string {
  if (body.length <= BODY_MAX_CHARS) return body;
  const head = body.slice(0, Math.floor(BODY_MAX_CHARS * 0.7));
  const tail = body.slice(-Math.floor(BODY_MAX_CHARS * 0.25));
  return `${head}\n\n[…truncated ${body.length - BODY_MAX_CHARS} chars…]\n\n${tail}`;
}

async function readNodeBodyRaw(node: typeof nodes.$inferSelect): Promise<string> {
  // ─── Secrets — metadata only ─────────────────────────────────────────
  // Critical security invariant: secrets pass title + description + tags
  // to the LLM, and NOTHING ELSE. The sealed value lives in the `secrets`
  // table; we never query it from this file. If you ever add a code path
  // that loads from `secrets` here, the entire threat model breaks.
  if (node.type === 'secret') {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const description = typeof data.description === 'string' ? data.description : '';
    const kind = typeof data.kind === 'string' ? data.kind : '';
    const tagLine = Array.isArray(node.tags) && node.tags.length > 0
      ? `\n\nTags: ${node.tags.join(', ')}`
      : '';
    const kindLine = kind ? `\n\nKind: ${kind}` : '';
    return `${node.title}${kindLine}\n\n${description}${tagLine}`.trim();
  }
  if (node.type === 'email' || node.type === 'email_thread') {
    const [row] = await db
      .select({ subject: emails.subject, bodyText: emails.bodyText })
      .from(emails)
      .where(eq(emails.nodeId, node.id))
      .limit(1);
    if (!row) return node.title;
    return [row.subject, row.bodyText].filter(Boolean).join('\n\n');
  }
  // ─── Tasks (todos) — body + structured metadata ──────────────────────
  // The extractor needs to know status/priority/due_at to write a useful
  // summary ("DONE: ship the secrets feature" vs "OPEN, due 2026-05-25").
  if (node.type === 'task') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const body = typeof d.body === 'string' ? d.body : '';
    const lines = [
      node.title,
      `Status: ${d.status ?? 'open'}`,
      `Priority: ${d.priority ?? 'normal'}`,
      ...(typeof d.due_at === 'string' ? [`Due: ${d.due_at}`] : []),
      ...(body ? ['', body] : []),
    ];
    return lines.join('\n');
  }
  // ─── Contacts — name + email/cell + the "who is this for AI" description.
  // The description carries the real semantic payload ("Modular sells aluminium
  // profiles, used for printer projects") so the extractor produces useful
  // facts + entities on the contact's identity. Keeping the structured fields
  // in the body too means search_nodes(q='@modular.co.za') still hits.
  if (node.type === 'contact') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const company = typeof d.company === 'string' ? d.company : '';
    const email = typeof d.email === 'string' ? d.email : '';
    const cc = typeof d.country_code === 'string' ? d.country_code : '';
    const cell = typeof d.cell === 'string' ? d.cell : '';
    const desc = typeof d.description === 'string' ? d.description : '';
    const lines = [
      node.title,
      ...(company && company !== node.title ? [`Company: ${company}`] : []),
      ...(email ? [`Email: ${email}`] : []),
      ...(cc || cell ? [`Cell: ${cc ?? ''} ${cell ?? ''}`.trim()] : []),
      ...(desc ? ['', desc] : []),
    ];
    return lines.join('\n');
  }
  // ─── Events — title + when + where + body ────────────────────────────
  if (node.type === 'event') {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const body = typeof d.body === 'string' ? d.body : '';
    const lines = [
      node.title,
      ...(typeof d.starts_at === 'string' ? [`Starts: ${d.starts_at}`] : []),
      ...(typeof d.ends_at === 'string' ? [`Ends: ${d.ends_at}`] : []),
      ...(typeof d.location === 'string' && d.location ? [`Location: ${d.location}`] : []),
      ...(body ? ['', body] : []),
    ];
    return lines.join('\n');
  }
  // ─── Pages — derived plaintext from the TipTap sidecar ───────────────
  // The ProseMirror doc lives in `pages.doc`; `pages.doc_text` is its
  // flattened plaintext, computed on every save in @mantle/content.
  if (node.type === 'page') {
    const [row] = await db
      .select({ docText: pages.docText })
      .from(pages)
      .where(eq(pages.nodeId, node.id))
      .limit(1);
    return row?.docText?.trim() ? row.docText : node.title;
  }
  // For note/file/sermon, body lives in data.content (or data.text/body).
  const data = (node.data ?? {}) as Record<string, unknown>;
  const candidates = [data.content, data.text, data.body, data.markdown];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  // file fallback: if data.content wasn't cached (binary uploads, or
  // text > 1MB), read from disk and parse via the shared dispatcher
  // (pdf/docx/xlsx → parser, text → UTF-8). On any parse failure
  // (encrypted/scanned/corrupt) fall through to the title.
  if (node.type === 'file' && typeof data.filename === 'string') {
    const filename = data.filename as string;
    const ext = extOf(filename);
    const diskPath = diskPathForFile(node.path, filename);
    if (!diskPath) return node.title;
    if (INGESTABLE_EXTS.has(ext)) {
      try {
        const { promises: fs } = await import('node:fs');
        const buf = await fs.readFile(diskPath);
        // Wrap the parse in a step so the trace shows WHICH tier ran
        // (pdf-parse / mammoth / sheetjs / utf8 / tika), how long it took,
        // and how many chars came out. Particularly important for Tika
        // since it's an HTTP call with its own failure modes (service down,
        // timeout, unparseable bytes — all swallowed to '' by design); the
        // step makes Tika invisible→visible without changing behaviour.
        const route = parserRouteForExt(ext);
        const text = await step(
          {
            name: 'parse_document',
            kind: 'compute',
            input: { ext, parser: route, bytes_in: buf.length, filename },
          },
          async (h) => {
            const t = await parseDocumentBytes(buf, ext);
            h.setMeta({ parser: route, chars_out: t.length, empty: t.trim().length === 0 });
            return t;
          },
        );
        if (text.trim().length > 0) return text;
      } catch {
        // Parse / disk read failed. The step (if it opened) already
        // recorded the error; fall through to the title.
      }
    }
  }
  return node.title;
}

/**
 * Vision-ingest an image file node: run the default vision worker (neutral
 * describe+OCR) over the bytes, persist the result as `data.text` (+
 * `vision_model`), and RETURN the text so the caller indexes it in the same
 * extractNode pass (summary + embedding + facts). Single pass — no
 * node_ingested re-fire, no second extractor round-trip.
 *
 * This is the SINGLE durable-metadata path for images, however they entered —
 * Files upload, disk-sync watcher, MCP file_upload, AND the chat/Telegram
 * surfaces (whose own inline vision is question-aware and used only for the
 * live reply; they no longer persist `data.text`, so every image lands here).
 *
 * The early `data.text` persist is deliberate robustness: the picture stays
 * searchable even if the caller's downstream summary/embedding step later
 * fails. Best-effort otherwise: a missing/unwired/erroring vision worker
 * returns null (image stays findable by filename) — the `photo_ingest` trace's
 * extract_vision step records the reason.
 */
async function visionIngestImageNode(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<string | null> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = data.filename as string;
  const diskPath = diskPathForFile(node.path, filename);
  if (!diskPath) return null;

  return await startTrace(
    {
      kind: 'photo_ingest',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      data: { source: 'extractor', filename },
    },
    async () => {
      const bytes = await step(
        { name: 'read_file', kind: 'compute', input: { filename } },
        async (h) => {
          const { promises: fs } = await import('node:fs');
          const buf = await fs.readFile(diskPath);
          h.setMeta({ bytes: buf.length });
          return buf;
        },
      );
      const mimeType = mimeForExt(extOf(filename));
      const result = await step(
        { name: 'extract_vision', kind: 'llm_call', input: { mime: mimeType, bytes: bytes.length } },
        async (h) => {
          // Neutral describe+OCR (no question) — the durable, query-independent
          // metadata pass. Shares the single vision implementation with the
          // conversational surfaces (HEIC transcode + worker resolution live
          // inside runVisionWorker). A missing/unwired/erroring worker returns
          // ran:false + a note rather than throwing; the trace records it.
          const r = await runVisionWorker({ ownerId, bytes, mimeType, filename });
          h.setMeta({
            ran: r.ran,
            note: r.note,
            model: r.model,
            adapter: r.adapterName,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            textLength: r.text.length,
          });
          return r;
        },
      );

      if (!result.text) return null; // nothing to index; the trace records why.

      // Persist data.text now (robustness — survives a later index failure),
      // then hand the text back to extractNode to index in this same pass.
      await step({ name: 'persist_vision_text', kind: 'db_write' }, async (h) => {
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || jsonb_build_object('text', ${result.text}::text, 'vision_model', ${result.model ?? ''}::text)`,
            updatedAt: new Date(),
          })
          .where(and(eq(nodes.id, node.id), eq(nodes.ownerId, ownerId)));
        h.setMeta({ chars: result.text.length });
      });
      return result.text;
    },
  );
}

/** Page cap for PDF OCR — bounds rasterization memory + per-page vision spend. */
const MAX_OCR_PAGES = 10;

/**
 * OCR-ingest a scanned / image-only PDF file node. When a PDF has no text layer
 * (`parseDocumentBytes` yields nothing and `readNodeBodyRaw` falls back to the
 * filename), rasterize its pages to PNG and run each through the default vision
 * worker — exactly the neutral describe+OCR path images already take. The
 * concatenated text is persisted as `data.text` (+ `vision_model`, `ocr`) and
 * RETURNED so extractNode indexes it in the same pass (summary + embedding +
 * facts). Best-effort: a missing/erroring vision worker, an unrenderable PDF,
 * or a blank scan returns null and the trace records why. Page-capped at
 * MAX_OCR_PAGES. Mirrors {@link visionIngestImageNode}.
 */
async function ocrIngestPdfNode(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<string | null> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const filename = data.filename as string;
  const diskPath = diskPathForFile(node.path, filename);
  if (!diskPath) return null;

  return await startTrace(
    {
      kind: 'photo_ingest',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      data: { source: 'extractor', mode: 'pdf_ocr', filename },
    },
    async () => {
      const buf = await step(
        { name: 'read_file', kind: 'compute', input: { filename } },
        async (h) => {
          const { promises: fs } = await import('node:fs');
          const b = await fs.readFile(diskPath);
          h.setMeta({ bytes: b.length });
          return b;
        },
      );

      // 1) Native PDF first — one call to the vision model (Claude/Gemini),
      //    whole-document context + real tables, no rasterization. Only runs
      //    when the worker's provider supports it; else falls through to the
      //    per-page raster OCR below.
      const native = await step(
        { name: 'extract_document', kind: 'llm_call', input: { mime: 'application/pdf', bytes: buf.length } },
        async (h) => {
          const r = await runDocumentWorker({ ownerId, bytes: buf, mimeType: 'application/pdf', filename });
          h.setMeta({ ran: r.ran, note: r.note, model: r.model, textLength: r.text.length, tokensOut: r.tokensOut });
          return r;
        },
      );
      if (native.ran && native.text.trim()) {
        const text = native.text.trim();
        await step({ name: 'persist_vision_text', kind: 'db_write' }, async (h) => {
          await db
            .update(nodes)
            // native PDF read, not page OCR — flag it accordingly (`native_pdf`)
            // so the marker is honest; downstream nothing reads `ocr` today.
            .set({
              data: sql`${nodes.data} || jsonb_build_object('text', ${text}::text, 'vision_model', ${native.model ?? ''}::text, 'native_pdf', true)`,
              updatedAt: new Date(),
            })
            .where(and(eq(nodes.id, node.id), eq(nodes.ownerId, ownerId)));
          h.setMeta({ chars: text.length, native: true });
        });
        return text;
      }

      // 2) Fall back to rasterize → per-page image OCR.
      const pages = await step(
        { name: 'rasterize_pdf', kind: 'compute', input: { max_pages: MAX_OCR_PAGES } },
        async (h) => {
          try {
            const { rasterizePdfToPngs } = await import('@mantle/files/rasterize');
            const r = await rasterizePdfToPngs(buf, { maxPages: MAX_OCR_PAGES });
            h.setMeta({ pages: r.length });
            return r;
          } catch (err) {
            // Unrenderable / corrupt / encrypted PDF — record and give up.
            h.setMeta({ pages: 0, error: err instanceof Error ? err.message : String(err) });
            return [];
          }
        },
      );
      if (pages.length === 0) return null;

      const parts: string[] = [];
      let model: string | null = null;
      for (const pg of pages) {
        const res = await step(
          {
            name: 'extract_vision',
            kind: 'llm_call',
            input: { page: pg.pageNumber, mime: 'image/png', bytes: pg.png.length },
          },
          async (h) => {
            const r = await runVisionWorker({
              ownerId,
              bytes: pg.png,
              mimeType: 'image/png',
              filename: `${filename}#page-${pg.pageNumber}.png`,
            });
            h.setMeta({
              ran: r.ran,
              note: r.note,
              model: r.model,
              page: pg.pageNumber,
              textLength: r.text.length,
            });
            return r;
          },
        );
        if (res.model) model = res.model;
        if (res.text.trim()) {
          parts.push(pages.length > 1 ? `[Page ${pg.pageNumber}]\n${res.text.trim()}` : res.text.trim());
        }
      }

      const text = parts.join('\n\n').trim();
      if (!text) return null; // worker unavailable / blank scan — trace records why.

      await step({ name: 'persist_vision_text', kind: 'db_write' }, async (h) => {
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || jsonb_build_object('text', ${text}::text, 'vision_model', ${model ?? ''}::text, 'ocr', true)`,
            updatedAt: new Date(),
          })
          .where(and(eq(nodes.id, node.id), eq(nodes.ownerId, ownerId)));
        h.setMeta({ chars: text.length, pages: pages.length });
      });
      return text;
    },
  );
}

function parseClassifierDecision(raw: string): ClassifierDecision {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as ClassifierDecision;
    if (!['ADD', 'UPDATE', 'DELETE', 'NOOP'].includes(parsed.decision)) {
      return { decision: 'ADD', target_index: null };
    }
    return parsed;
  } catch {
    return { decision: 'ADD', target_index: null };
  }
}

/**
 * Single-turn chat completion through the adapter registry.
 *
 * Phase-3 shape: the extractor used to construct `new OpenRouter()`
 * directly and call `client.chat.send` regardless of what the worker
 * said. Now it resolves the chat adapter for `worker.provider` and
 * goes through `adapter.chat()` — so a worker configured for direct
 * Anthropic / direct Google / xAI / HF actually routes there instead
 * of falling through to OpenRouter.
 *
 * Returns the typed ChatResult so the call site can pass it straight
 * to `recordChatUsage` without scraping a raw response.
 */
export async function chatComplete(
  adapter: ChatDispatcher,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string,
  params: ExtractorParams,
): Promise<ChatResult> {
  return await adapter.chat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    // The extractor's system prompt is identical across every node
    // ingest (modulo per-worker customisation, which is also static
    // per worker). Mark it cacheable — Anthropic-direct workers get
    // ~10× cheaper input on the second+ call within the 5-min TTL;
    // non-cache-aware providers (Google, xAI, HF) ignore the field.
    // During a backfill or active ingest hour this is the dominant
    // cost-saving knob.
    cacheControl: { systemPrompt: true },
    ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
    ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
  });
}

// ─── Entity reconciliation ──────────────────────────────────────────────────

async function reconcileEntity(
  ownerId: string,
  mention: { name: string; kind: string },
  embeddingModel?: string,
): Promise<Entity> {
  // 1. Exact name (case-insensitive) or alias match first — cheapest.
  const trimmed = mention.name.trim();
  const [exact] = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        sql`lower(${entities.name}) = lower(${trimmed}) or ${trimmed} = any(${entities.aliases})`,
      ),
    )
    .limit(1);
  if (exact) return exact;

  // 2. Trigram fuzzy match within the same kind. Pick the strongest similarity.
  const trgmHits = await db
    .select({
      row: entities,
      sim: sql<number>`similarity(${entities.name}, ${trimmed})`,
    })
    .from(entities)
    .where(and(eq(entities.ownerId, ownerId), eq(entities.kind, mention.kind)))
    .orderBy(sql`similarity(${entities.name}, ${trimmed}) desc`)
    .limit(1);
  if (trgmHits[0] && trgmHits[0].sim >= 0.7) {
    const existing = trgmHits[0].row;
    // Same-surname-different-given guard: surname alone hits the trigram
    // threshold, which would alias "Don Schoeman" into "Jason Schoeman". For
    // kind='person' we refuse the merge when both names look like full
    // given-name+surname pairs with the same surname but distinct given names.
    // Falls through to the embedding match below, which carries the same guard.
    if (!isLikelyDifferentPerson(mention, existing)) {
      // Looks like a match — register the new spelling as an alias.
      if (!existing.aliases.includes(trimmed) && existing.name.toLowerCase() !== trimmed.toLowerCase()) {
        await db
          .update(entities)
          .set({ aliases: [...existing.aliases, trimmed], updatedAt: new Date() })
          .where(eq(entities.id, existing.id));
      }
      return existing;
    }
  }

  // 3. Embedding match (when populated). We embed the mention only when we
  // need to compare; cheap thanks to the embedding_cache.
  try {
    const [mentionVec] = await Promise.all([
      embed(ownerId, trimmed, embeddingModel ? { model: embeddingModel } : undefined),
    ]);
    const vecHits = await db
      .select({
        row: entities,
        dist: sql<number>`${entities.embedding} <=> ${JSON.stringify(mentionVec)}::vector`,
      })
      .from(entities)
      .where(and(eq(entities.ownerId, ownerId), eq(entities.kind, mention.kind)))
      .orderBy(sql`${entities.embedding} <=> ${JSON.stringify(mentionVec)}::vector`)
      .limit(1);
    if (vecHits[0] && (vecHits[0].dist ?? 1) < ENTITY_DEDUP_THRESHOLD) {
      const existing = vecHits[0].row;
      // Same guard as the trigram path: embeddings of "Don Schoeman" and
      // "Jason Schoeman" are close enough to merge by default, which is wrong
      // for distinct people sharing a surname.
      if (!isLikelyDifferentPerson(mention, existing)) {
        if (!existing.aliases.includes(trimmed) && existing.name.toLowerCase() !== trimmed.toLowerCase()) {
          await db
            .update(entities)
            .set({ aliases: [...existing.aliases, trimmed], updatedAt: new Date() })
            .where(eq(entities.id, existing.id));
        }
        return existing;
      }
    }
  } catch {
    // embedding failure shouldn't block entity creation.
  }

  // 4. No match — create new entity (embed its name + kind for future matches).
  let embedding: number[] | null = null;
  try {
    embedding = await embed(
      ownerId,
      `${mention.kind}: ${trimmed}`,
      embeddingModel ? { model: embeddingModel } : undefined,
    );
  } catch {
    // OK to create without embedding; can be backfilled later.
  }
  const [inserted] = await db
    .insert(entities)
    .values({
      ownerId,
      kind: mention.kind,
      name: trimmed,
      aliases: [],
      embedding,
    })
    .returning();
  if (!inserted) throw new Error('extractor: failed to insert entity');
  return inserted;
}

// ─── Fact classification ────────────────────────────────────────────────────

async function classifyAndApplyFact(
  ownerId: string,
  candidate: ExtractedFact,
  candidateEmbedding: number[],
  sourceNodeId: string,
  primaryEntityId: string | null,
  adapter: ChatDispatcher,
  apiKey: string,
  worker: AiWorker,
): Promise<'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'> {
  // Find near-neighbour facts among currently-valid rows.
  const neighbours = await db
    .select({
      id: facts.id,
      content: facts.content,
      dist: sql<number>`${facts.embedding} <=> ${JSON.stringify(candidateEmbedding)}::vector`,
    })
    .from(facts)
    .where(
      and(
        eq(facts.ownerId, ownerId),
        isNull(facts.validTo),
        sql`${facts.embedding} is not null`,
      ),
    )
    .orderBy(sql`${facts.embedding} <=> ${JSON.stringify(candidateEmbedding)}::vector`)
    .limit(CLASSIFIER_NEIGHBOURS);

  const closeNeighbours = neighbours.filter((n) => (n.dist ?? 1) <= FACT_DEDUP_THRESHOLD);

  // Fast path: no close neighbours → just ADD.
  if (closeNeighbours.length === 0) {
    await db.insert(facts).values({
      ownerId,
      content: candidate.content,
      kind: candidate.kind,
      entityId: primaryEntityId,
      confidence: candidate.confidence,
      validFrom: new Date(),
      sourceNodeId,
      embedding: candidateEmbedding,
    });
    return 'ADD';
  }

  // Slow path: call the classifier to decide.
  const params = (worker.params ?? {}) as ExtractorParams;
  const decisionResult = await chatComplete(
    adapter,
    apiKey,
    worker.model,
    'You are a precise JSON output assistant. Output strictly the JSON requested, with no additional commentary.',
    CLASSIFIER_PROMPT_TEMPLATE(candidate.content, closeNeighbours.map((n) => n.content)),
    params,
  );
  const decision = parseClassifierDecision(decisionResult.text);

  const targetIdx = decision.target_index ? decision.target_index - 1 : null;
  const target = targetIdx != null ? closeNeighbours[targetIdx] : null;

  if (decision.decision === 'NOOP') return 'NOOP';

  const now = new Date();
  if (decision.decision === 'DELETE' && target) {
    await db.update(facts).set({ validTo: now, updatedAt: now }).where(eq(facts.id, target.id));
    return 'DELETE';
  }

  if (decision.decision === 'UPDATE' && target) {
    // Retire the old, insert the new pointing back via supersededBy.
    await db.update(facts).set({ validTo: now, updatedAt: now }).where(eq(facts.id, target.id));
    const [inserted] = await db
      .insert(facts)
      .values({
        ownerId,
        content: candidate.content,
        kind: candidate.kind,
        entityId: primaryEntityId,
        confidence: candidate.confidence,
        validFrom: now,
        sourceNodeId,
        embedding: candidateEmbedding,
        supersededBy: null,
      })
      .returning({ id: facts.id });
    if (inserted) {
      // Older row's superseded_by points at the newer row.
      await db.update(facts).set({ supersededBy: inserted.id }).where(eq(facts.id, target.id));
    }
    return 'UPDATE';
  }

  // Default: ADD (even if classifier said UPDATE/DELETE but no valid target).
  await db.insert(facts).values({
    ownerId,
    content: candidate.content,
    kind: candidate.kind,
    entityId: primaryEntityId,
    confidence: candidate.confidence,
    validFrom: new Date(),
    sourceNodeId,
    embedding: candidateEmbedding,
  });
  return 'ADD';
}

// ─── The main entrypoint ────────────────────────────────────────────────────

export async function extractNode(nodeId: string, ownerId: string): Promise<void> {
  // Every early-return below now records a `skipped` trace so the
  // operator can see WHY the extractor declined to run this node.
  // Previously these were silent returns and "I uploaded X but
  // nothing happened" was un-debuggable. See migration 0029 +
  // recordSkippedTrace in @mantle/tracing.

  const worker = await resolveExtractor(ownerId);
  if (!worker) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      disposition: 'no_extractor_worker',
      details: {
        hint: 'Configure an extractor at /settings/ai-workers and mark it default.',
      },
    });
    return;
  }

  // Load the node.
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      disposition: 'node_not_found',
      details: { worker_slug: worker.slug },
    });
    return;
  }
  if (HARD_SKIP_TYPES.has(node.type)) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      disposition: 'hard_skip_type',
      details: {
        node_type: node.type,
        worker_slug: worker.slug,
        hint: `Type '${node.type}' is hard-coded as skip (transient/internal kinds).`,
      },
    });
    return;
  }

  // Conversation digests are ALREADY summaries (authored by the
  // summarizer into data.summary, with no data.content). Re-running the
  // extractor on them re-summarises from the *title* and overwrites
  // data.summary with a useless paraphrase — destroying the real digest
  // and corrupting Layer-3 memory (the responder reads data.summary).
  // Never extract them.
  const digestData = (node.data ?? {}) as Record<string, unknown>;
  const isConversationDigest =
    node.type === 'note' &&
    ((node.tags ?? []).includes('conversation-digest') ||
      digestData.kind === 'conversation_digest');
  if (isConversationDigest) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'conversation_digest',
      details: {
        node_type: node.type,
        worker_slug: worker.slug,
        hint: 'Conversation digests are authored summaries — the extractor must not re-summarise them.',
      },
    });
    return;
  }

  // target_types is the new home for the type allowlist. We still
  // accept extract_types for legacy backfilled rows in the same
  // params blob — extractTypes prefers the new name.
  const params = (worker.params ?? {}) as ExtractorParams;
  const extractTypes =
    params.target_types ?? params.extract_types ?? DEFAULT_EXTRACT_TYPES;
  // `*` is a wildcard meaning "any non-HARD_SKIP type" — already enforced above.
  if (!extractTypes.includes('*') && !extractTypes.includes(node.type)) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'type_not_in_allowlist',
      details: {
        node_type: node.type,
        allowed_types: extractTypes,
        worker_slug: worker.slug,
        hint: `Add '${node.type}' (or '*') to the worker's target_types param to extract it.`,
      },
    });
    return;
  }

  if (!worker.apiKeyId) {
    console.error(`[extractor] worker '${worker.slug}' has no api_key_id — skipping`);
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'no_api_key_id',
      details: { worker_slug: worker.slug, node_type: node.type },
    });
    return;
  }
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) {
    console.error(`[extractor] api_key_id ${worker.apiKeyId} not found — skipping`);
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'api_key_not_decryptable',
      details: { worker_slug: worker.slug, api_key_id: worker.apiKeyId },
    });
    return;
  }

  // Skip if we've already extracted this node (data.summary present + embedding set).
  const existingData = (node.data ?? {}) as Record<string, unknown>;
  if (existingData.summary && node.embedding) {
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'already_extracted',
      details: {
        worker_slug: worker.slug,
        node_type: node.type,
        title: node.title,
        existing_summary_chars:
          typeof existingData.summary === 'string' ? existingData.summary.length : null,
        has_embedding: true,
      },
    });
    return;
  }

  // Image file nodes carry no text body until a vision worker reads them.
  // The chat / Telegram upload paths do that inline, but an image dropped
  // into /files (web upload, disk-sync watcher, or MCP file_upload) arrives
  // here untouched — readNodeBodyRaw returns just the filename for it. Run the
  // default vision worker, which persists the description/OCR as data.text and
  // returns it so we index it in THIS pass below (summary + embedding + facts)
  // — no second extractor round-trip. One code path turns image bytes into
  // searchable text however the image landed. Images that already carry
  // data.text (e.g. re-extraction) fall through to readNodeBodyRaw unchanged.
  const isImageNeedingVision =
    node.type === 'file' &&
    !existingData.text &&
    !existingData.content &&
    typeof existingData.filename === 'string' &&
    mimeForExt(extOf(existingData.filename)).startsWith('image/');

  // Read the FULL extracted text once. `body` (truncated) is what the LLM
  // sees; `rawBody` is what we persist so the document stays retrievable.
  let rawBody: string;
  if (isImageNeedingVision) {
    const visionText = await visionIngestImageNode(node, ownerId);
    if (!visionText) return; // worker unavailable / empty — nothing to index
    rawBody = visionText;
  } else {
    rawBody = await readNodeBodyRaw(node);
  }

  // Scanned / image-only PDF: readNodeBodyRaw found no text layer and fell back
  // to the title (filename). Indexing that would silently mask the failure — a
  // filename-only summary recorded as `success` (the passport-PDF case). Before
  // giving up, try OCR via the vision worker (rasterize → describe+OCR), the
  // same route images take. Only triggered when the body IS the filename, so a
  // PDF with a real text layer never pays the OCR cost.
  const isPdfWithoutTextLayer =
    node.type === 'file' &&
    !existingData.text &&
    !existingData.content &&
    typeof existingData.filename === 'string' &&
    extOf(existingData.filename as string) === 'pdf' &&
    rawBody.trim() === node.title.trim();
  // prefer_native: a PDF WITH a text layer, but the document worker is set to
  // always read PDFs through the model (tabular docs whose text layer scrambles
  // columns). Run the same native path; keep the text-layer body if native
  // yields nothing, so we never end up worse than the cheap path.
  const isPdfWithTextLayer =
    node.type === 'file' &&
    !existingData.text &&
    !existingData.content &&
    typeof existingData.filename === 'string' &&
    extOf(existingData.filename as string) === 'pdf' &&
    !isPdfWithoutTextLayer;
  const preferNativePdf = isPdfWithTextLayer && (await documentWorkerPrefersNative(ownerId));

  if (isPdfWithoutTextLayer) {
    const ocrText = await ocrIngestPdfNode(node, ownerId);
    if (ocrText && ocrText.trim().length >= 20) {
      rawBody = ocrText;
    } else {
      // No text layer AND OCR produced nothing (no/unwired vision worker, an
      // unrenderable PDF, or a blank scan). Record an honest skip instead of a
      // filename-only false success.
      await recordSkippedTrace({
        kind: 'extractor_run',
        ownerId,
        subjectId: node.id,
        subjectKind: 'node',
        disposition: 'no_text_layer',
        details: {
          worker_slug: worker.slug,
          node_type: node.type,
          title: node.title,
          filename: existingData.filename,
          hint: 'PDF has no extractable text layer and OCR produced nothing — configure a default vision worker at /settings/ai-workers, or re-upload as an image. A blank/illegible scan can also land here.',
        },
      });
      return;
    }
  } else if (preferNativePdf) {
    const nativeText = await ocrIngestPdfNode(node, ownerId);
    // Only replace the text-layer body if native produced something usable;
    // otherwise keep the text we already have (native is best-effort here).
    if (nativeText && nativeText.trim().length >= 20) rawBody = nativeText;
  }

  if (!rawBody || rawBody.trim().length < 20) {
    // Not enough content to extract meaningfully.
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'body_too_short',
      details: {
        worker_slug: worker.slug,
        node_type: node.type,
        title: node.title,
        body_chars: rawBody?.length ?? 0,
        threshold_chars: 20,
        hint: 'The extractor wants ≥20 chars of body content. Title-only nodes are skipped.',
      },
    });
    return;
  }
  const body = truncateForPrompt(rawBody);

  // Persist the full text for binary file nodes (pdf/docx/xlsx) — their
  // body lives nowhere else (text files cache it in data.content; emails
  // keep it in the emails table). Without this, only the summary survives
  // and "write out the full document" is impossible. node_read / file_read
  // return data.text so the assistant can reproduce the content on demand.
  const persistedText =
    node.type === 'file' && !existingData.content
      ? rawBody.slice(0, TEXT_STORE_MAX_CHARS)
      : undefined;

  // Resolve the chat adapter for this worker's provider. Phase-3
  // change: was `new OpenRouter({apiKey})` regardless of what the
  // worker said. Now the worker.provider field actually steers the
  // dispatch. If no adapter is wired for the provider, surface a
  // clear skipped trace rather than crashing — operators see what's
  // missing in /traces.
  const adapter = getChatAdapter(worker.provider);
  if (!adapter) {
    console.error(
      `[extractor] no chat adapter registered for provider '${worker.provider}' — skipping`,
    );
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      disposition: 'unwired_provider',
      details: {
        worker_slug: worker.slug,
        provider: worker.provider,
        model: worker.model,
        hint: `Register a chat adapter for '${worker.provider}' in packages/voice/src/adapters/index.ts, or switch the worker to a wired provider.`,
      },
    });
    return;
  }

  console.log(
    `[extractor] node ${node.id.slice(0, 8)} (${node.type}, ${node.title.slice(0, 40)}) via ${adapter.adapterName}:${worker.model}`,
  );

  const embeddingModel = params.embedding_model;
  const embedOpts = embeddingModel ? { model: embeddingModel } : undefined;

  await startTrace(
    {
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      // NOTE: deliberately no agentId. The trace_kind extractor_run
      // belongs to an ai_worker, but traces.agent_id is FK-constrained
      // to the `agents` table (legacy from the era when extractor was
      // an agent). Passing worker.id silently FK-violated the insert
      // and every trace vanished. worker_slug + worker_id below carry
      // the navigation handle we want.
      data: {
        nodeType: node.type,
        title: node.title,
        model: worker.model,
        provider: worker.provider,
        worker_slug: worker.slug,
        worker_id: worker.id,
        embeddingModel: embeddingModel ?? null,
      },
    },
    async () => {
      const systemPrompt = worker.systemPrompt || DEFAULT_EXTRACTOR_PROMPT;
      const userPayload = `Title: ${node.title}\nType: ${node.type}\n\nBody:\n${body.slice(0, 8000)}`;

      const parsed = await step(
        {
          name: 'llm_extract',
          kind: 'llm_call',
          input: {
            model: worker.model,
            provider: worker.provider,
            // Surface everything the LLM saw. No per-field char caps —
            // the global truncateJson budget (64KB) catches truly
            // runaway bodies and the node itself lives in /files for
            // larger reads. Operators want the full preview when
            // debugging "what did the extractor actually read?".
            title: node.title,
            node_type: node.type,
            body_chars: body.length,
            body_preview: body,
          },
        },
        async (h) => {
          const r = await chatComplete(
            adapter,
            apiKey,
            worker.model,
            systemPrompt,
            userPayload,
            params,
          );
          recordChatUsage(h, r, worker.model);
          const result = parseExtractorOutput(r.text, { nodeId: node.id, model: worker.model });
          // Capture the full model output — summary, all entities,
          // all facts. truncateJson at the tracing layer will only
          // bite if the combined JSON exceeds 64KB, which is
          // generous for normal extractor outputs.
          h.setOutput({
            summary: result.summary,
            entity_count: result.entities.length,
            entities: result.entities.map((e) => ({
              name: e.name,
              kind: e.kind ?? 'unknown',
            })),
            fact_count: result.facts.length,
            facts: result.facts.map((f) => f.content),
          });
          return result;
        },
      );

      // ─── content_index pass ───────────────────────────────────────────
      const summary = parsed.summary;
      const allEntityMentions = [
        ...parsed.entities,
        ...parsed.facts.flatMap((f) => f.entities ?? []),
      ];
      const seenNames = new Set<string>();
      const uniqueMentions = allEntityMentions.filter((m) => {
        const key = m.name.trim().toLowerCase();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });

      // Embed against title + summary. The summary already condenses the
      // full body (after head+tail truncation), so it's a faithful
      // representation regardless of how long the original was.
      // Previously we appended `body.slice(0, 500)` here, which gave
      // long emails / PDFs an embedding biased toward the first ~500
      // chars (lede only) and made vector search find them by greeting,
      // not by content. The summary is what we want indexed.
      const embedText = [node.title, summary]
        .filter(Boolean)
        .join('\n\n');
      let embedding: number[] | null = null;
      try {
        embedding = await embed(ownerId, embedText, embedOpts);
      } catch (err) {
        console.error('[extractor] embed failed:', err instanceof Error ? err.message : err);
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
          };
          await db
            .update(nodes)
            .set({
              data: sql`${nodes.data} || ${JSON.stringify(indexPatch)}::jsonb`,
              ...(embedding ? { embedding } : {}),
              updatedAt: new Date(),
            })
            .where(eq(nodes.id, node.id));
          h.setMeta({
            summaryLength: summary.length,
            embedded: !!embedding,
            textStored: persistedText?.length ?? 0,
          });
        },
      );

      console.log(
        `[extractor]   → content_index: summary (${summary.length}c), ${uniqueMentions.length} entities`,
      );

      // ─── chunked retrieval index ─────────────────────────────────────
      // Rebuild this node's retrieval chunks (delete-for-node, then insert)
      // so re-extracts REPLACE rather than accumulate. Long docs become
      // section-sized, individually-embedded chunks; short ones a single
      // whole-body chunk — uniform chunk-level search across all content.
      await step(
        { name: 'write_chunks', kind: 'compute', input: { bodyChars: rawBody.length } },
        async (h) => {
          await db.delete(contentChunks).where(eq(contentChunks.nodeId, node.id));
          const pieces = chunkDocText(rawBody);
          if (pieces.length === 0) {
            h.setOutput({ chunks: 0 });
            return;
          }
          let vectors: number[][] = [];
          try {
            const { embedBatch } = await import('@mantle/embeddings');
            vectors = await embedBatch(
              ownerId,
              pieces.map((p) => p.text),
              embedOpts,
            );
          } catch (err) {
            console.error(
              '[extractor]   chunk embed failed:',
              err instanceof Error ? err.message : err,
            );
            h.setOutput({ chunks: 0, embedFailed: true });
            return;
          }
          await db.insert(contentChunks).values(
            pieces.map((p, i) => ({
              ownerId,
              nodeId: node.id,
              ordinal: i,
              headingPath: p.headingPath ?? null,
              text: p.text,
              embedding: vectors[i] ?? null,
            })),
          );
          h.setOutput({ chunks: pieces.length });
        },
      );

      // ─── entity reconciliation ───────────────────────────────────────
      const entityIdByName = await step(
        {
          name: 'reconcile_entities',
          kind: 'compute',
          input: {
            mentions: uniqueMentions.length,
            // Full list of mentions — names + kinds. truncateJson
            // applies the safety net at 64KB; a normal extractor
            // pass fits comfortably. The arrays-over-50 cap in
            // truncate.ts catches genuinely runaway iterations.
            preview: uniqueMentions.map((m) => ({
              name: m.name,
              kind: m.kind ?? 'unknown',
            })),
          },
        },
        async (h) => {
          // Idempotent rebuild: clear this node's prior edges so re-extracts
          // REPLACE rather than append duplicates — both the inbound mention
          // edges (entity → this node) and this node's outbound page/note
          // links (this node → other node).
          await db
            .delete(entityEdges)
            .where(
              and(
                eq(entityEdges.targetId, node.id),
                eq(entityEdges.targetKind, 'node'),
                eq(entityEdges.relation, 'mentioned_in'),
              ),
            );
          await db
            .delete(entityEdges)
            .where(
              and(
                eq(entityEdges.sourceId, node.id),
                eq(entityEdges.sourceKind, 'node'),
                eq(entityEdges.relation, 'references'),
              ),
            );
          const map = new Map<string, string>();
          // Entity ids that already have an edge this rebuild — dedupes the
          // NER pass against the explicit @-mention pass below.
          const edgedEntityIds = new Set<string>();
          let created = 0;
          let matched = 0;
          for (const mention of uniqueMentions) {
            try {
              const before = await db
                .select({ id: entities.id })
                .from(entities)
                .where(
                  and(
                    eq(entities.ownerId, ownerId),
                    sql`lower(${entities.name}) = lower(${mention.name.trim()})`,
                  ),
                )
                .limit(1);
              const ent = await reconcileEntity(ownerId, mention, embeddingModel);
              map.set(mention.name.trim().toLowerCase(), ent.id);
              if (before.length > 0) matched++;
              else created++;
              await db.insert(entityEdges).values({
                ownerId,
                sourceId: ent.id,
                sourceKind: 'entity',
                targetId: node.id,
                targetKind: 'node',
                relation: 'mentioned_in',
                validFrom: new Date(),
              });
              edgedEntityIds.add(ent.id);
            } catch (err) {
              console.error(
                `[extractor]   entity '${mention.name}' failed:`,
                err instanceof Error ? err.message : err,
              );
            }
          }

          // ─── explicit @-mentions / links (pages) ─────────────────────
          // A page's chips carry resolved ids. Entity refs → precise
          // `mentioned_in` edges (independent of NER recall, deduped against
          // the loop above). Node refs → `node --references--> node` edges
          // (backlinks). Both skip ids whose target no longer exists (edges
          // have no FK; integrity is application-level).
          let explicit = 0;
          let refs = 0;
          if (node.type === 'page') {
            try {
              const [pageRow] = await db
                .select({ doc: pages.doc })
                .from(pages)
                .where(eq(pages.nodeId, node.id))
                .limit(1);
              const { entityIds, nodeIds } = mentionRefs(pageRow?.doc);

              for (const entId of entityIds) {
                if (edgedEntityIds.has(entId)) continue;
                const [ent] = await db
                  .select({ id: entities.id })
                  .from(entities)
                  .where(and(eq(entities.id, entId), eq(entities.ownerId, ownerId)))
                  .limit(1);
                if (!ent) continue;
                await db.insert(entityEdges).values({
                  ownerId,
                  sourceId: ent.id,
                  sourceKind: 'entity',
                  targetId: node.id,
                  targetKind: 'node',
                  relation: 'mentioned_in',
                  validFrom: new Date(),
                  data: { explicit: true },
                });
                edgedEntityIds.add(ent.id);
                explicit++;
              }

              const refSeen = new Set<string>();
              for (const refId of nodeIds) {
                if (refId === node.id || refSeen.has(refId)) continue;
                const [target] = await db
                  .select({ id: nodes.id })
                  .from(nodes)
                  .where(and(eq(nodes.id, refId), eq(nodes.ownerId, ownerId)))
                  .limit(1);
                if (!target) continue;
                await db.insert(entityEdges).values({
                  ownerId,
                  sourceId: node.id,
                  sourceKind: 'node',
                  targetId: refId,
                  targetKind: 'node',
                  relation: 'references',
                  validFrom: new Date(),
                  data: { explicit: true },
                });
                refSeen.add(refId);
                refs++;
              }
            } catch (err) {
              console.error(
                '[extractor]   page mention/link edges failed:',
                err instanceof Error ? err.message : err,
              );
            }
          }

          h.setOutput({ matched, created, explicit, refs });
          return map;
        },
      );

      // ─── fact extraction pass ────────────────────────────────────────
      if (params.extract_facts === false || parsed.facts.length === 0) {
        void bumpWorkerUsage(worker.id);
        return;
      }

      const factTexts = parsed.facts.map((f) => f.content);
      let factVectors: number[][] = [];
      try {
        const { embedBatch } = await import('@mantle/embeddings');
        factVectors = await embedBatch(ownerId, factTexts, embedOpts);
      } catch (err) {
        console.error(
          '[extractor] fact embed batch failed:',
          err instanceof Error ? err.message : err,
        );
        return;
      }

      // Treat 0 / negative / non-numeric as "no cap". `?? null` alone is a
      // trap: a configured 0 survives (0 ?? null === 0) and, because the
      // llm_extract step has already spent money by the time we get here,
      // `spent >= 0` is always true — so every fact gets dropped at #0. A 0
      // means "unlimited", not "zero budget".
      const rawCostCap = params.extract_cost_cap_micro_usd;
      const costCap =
        typeof rawCostCap === 'number' && rawCostCap > 0 ? rawCostCap : null;

      const tally = await step(
        {
          name: 'process_facts',
          kind: 'compute',
          input: {
            candidates: parsed.facts.length,
            costCapMicroUsd: costCap,
            // Full list of fact candidates — content + their entities.
            // truncateJson safety net at 64KB; arrays-over-50 cap in
            // truncate.ts catches genuinely runaway iterations.
            preview: parsed.facts.map((f) => ({
              content: f.content,
              entities: (f.entities ?? []).map((e) => e.name),
            })),
          },
        },
        async (h) => {
          const t = { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0 };
          let capExceededAt: number | null = null;
          for (let i = 0; i < parsed.facts.length; i++) {
            if (costCap != null) {
              const spent = currentTrace()?.costMicroUsd ?? 0;
              if (spent >= costCap) {
                capExceededAt = i;
                // Surface every dropped fact so a tight cap isn't an
                // invisible data-loss event. The previous code summed
                // them up only after the loop and left the individual
                // contents undiscoverable.
                const dropped = parsed.facts.slice(i).map((f) => f.content);
                console.warn(
                  `[extractor] cost cap ${costCap}µ$ hit at fact ${i}/${parsed.facts.length}; ` +
                    `dropping ${dropped.length} fact(s) from node ${node.id}:`,
                  dropped,
                );
                break;
              }
            }
            const candidate = parsed.facts[i]!;
            const vec = factVectors[i]!;
            let primaryEntityId: string | null = null;
            for (const e of candidate.entities ?? []) {
              const id = entityIdByName.get(e.name.trim().toLowerCase());
              if (id) {
                primaryEntityId = id;
                break;
              }
            }
            try {
              const decision = await classifyAndApplyFact(
                ownerId,
                candidate,
                vec,
                node.id,
                primaryEntityId,
                adapter,
                apiKey,
                worker,
              );
              t[decision]++;
            } catch (err) {
              console.error(
                '[extractor]   fact classify failed:',
                err instanceof Error ? err.message : err,
              );
            }
          }
          const output: Record<string, unknown> = { ...t };
          if (capExceededAt != null) {
            output.costCapHitAt = capExceededAt;
            output.processed = capExceededAt;
            output.skipped = parsed.facts.length - capExceededAt;
            h.setMeta({
              costCapMicroUsd: costCap,
              spentMicroUsd: currentTrace()?.costMicroUsd ?? 0,
            });
            console.warn(
              `[extractor]   cost cap ${costCap}µ$ hit after ${capExceededAt}/${parsed.facts.length} facts — skipping rest`,
            );
          }
          h.setOutput(output);
          return t;
        },
      );

      console.log(
        `[extractor]   → facts: ADD=${tally.ADD} UPDATE=${tally.UPDATE} DELETE=${tally.DELETE} NOOP=${tally.NOOP}`,
      );

      void bumpWorkerUsage(worker.id);
    },
  );
}

// bumpAgentUsage was removed when the extractor moved to ai_workers.
// Use bumpWorkerUsage from @mantle/db instead.
