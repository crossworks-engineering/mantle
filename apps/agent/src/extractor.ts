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

import { OpenRouter } from '@openrouter/sdk';
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
  type Agent,
  type AgentMemoryConfig,
  type AiWorker,
  type ExtractorParams,
  type Entity,
  type Fact,
} from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { embed } from '@mantle/embeddings';
import { diskPathForFile, extOf, INGESTABLE_EXTS } from '@mantle/files';
import { currentTrace, recordSkippedTrace, startTrace, step } from '@mantle/tracing';
import { captureLlmUsage } from '@mantle/agent-runtime';

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
const DEFAULT_EXTRACT_TYPES = ['note', 'file', 'email', 'email_thread', 'secret', 'task', 'event'];

/** Max characters of body text we feed the summarizer in one shot.
 *  Long emails / PDFs get truncated to keep the prompt bounded and the
 *  cost predictable. A summary is a spine, not a full recap. */
const BODY_MAX_CHARS = 24_000;

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

Guidelines:
- "factual" = a verifiable claim with a value ("Jason's birthday is March 4").
- "episodic" = a record of something that happened on a specific date ("On 2026-03-04 Jason mentioned his birthday").
- "semantic" = a stable abstract identity ("Jason is a pastor").
- "preference" = a stable interaction preference ("Jason prefers concise replies").
- If the content doesn't reveal anything beyond what's already in its title, return an empty facts array.
- Be conservative on confidence — 1.0 only for explicitly stated facts; 0.5-0.8 for reasonable inferences.
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

/** Read the source body for a node, dispatched on type. Email/file/note/sermon
 *  for now; expand the switch as we wire more types. */
async function readNodeBody(node: typeof nodes.$inferSelect): Promise<string> {
  const body = await readNodeBodyRaw(node);
  if (body.length <= BODY_MAX_CHARS) return body;
  // Keep head + tail so the model sees both the lede and the sign-off
  // (which often carries the most action items in long emails).
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
  // For note/file/sermon, body lives in data.content (or data.text/body).
  const data = (node.data ?? {}) as Record<string, unknown>;
  const candidates = [data.content, data.text, data.body, data.markdown];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  // file fallback: if data.content wasn't cached (binary uploads, or
  // text > 1MB), try the disk. Text files come back UTF-8; PDFs route
  // through pdf-parse and return their extracted text layer.
  if (node.type === 'file' && typeof data.filename === 'string') {
    const filename = data.filename as string;
    const ext = extOf(filename);
    const diskPath = diskPathForFile(node.path, filename);
    if (!diskPath) return node.title;
    if (ext === 'pdf') {
      try {
        const { promises: fs } = await import('node:fs');
        const buf = await fs.readFile(diskPath);
        const { parsePdf } = await import('@mantle/files/pdf');
        return await parsePdf(buf);
      } catch {
        // PDF parse failed (encrypted, scanned-image, corrupt). Fall through.
      }
    } else if (INGESTABLE_EXTS.has(ext)) {
      try {
        const { promises: fs } = await import('node:fs');
        return await fs.readFile(diskPath, 'utf8');
      } catch {
        // Disk read failed (file missing, permissions). Fall through.
      }
    }
  }
  return node.title;
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

/** Call OpenRouter for a chat completion with the agent's model/params.
 *  Returns both the assistant content and the raw result (the latter so
 *  callers can capture usage into a trace step). */
async function chatComplete(
  client: OpenRouter,
  model: string,
  systemPrompt: string,
  userText: string,
  params: ExtractorParams,
): Promise<{ content: string; raw: unknown }> {
  const result = await client.chat.send({
    chatRequest: {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params.max_tokens === 'number' ? { maxTokens: params.max_tokens } : {}),
      ...(typeof params.top_p === 'number' ? { topP: params.top_p } : {}),
    },
  });
  if (!('choices' in result)) {
    throw new Error('extractor: unexpected streaming response');
  }
  const content = result.choices[0]?.message?.content;
  return { content: typeof content === 'string' ? content : '', raw: result };
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
    // Looks like a match — register the new spelling as an alias.
    const existing = trgmHits[0].row;
    if (!existing.aliases.includes(trimmed) && existing.name.toLowerCase() !== trimmed.toLowerCase()) {
      await db
        .update(entities)
        .set({ aliases: [...existing.aliases, trimmed], updatedAt: new Date() })
        .where(eq(entities.id, existing.id));
    }
    return existing;
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
      if (!existing.aliases.includes(trimmed) && existing.name.toLowerCase() !== trimmed.toLowerCase()) {
        await db
          .update(entities)
          .set({ aliases: [...existing.aliases, trimmed], updatedAt: new Date() })
          .where(eq(entities.id, existing.id));
      }
      return existing;
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
  client: OpenRouter,
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
    client,
    worker.model,
    'You are a precise JSON output assistant. Output strictly the JSON requested, with no additional commentary.',
    CLASSIFIER_PROMPT_TEMPLATE(candidate.content, closeNeighbours.map((n) => n.content)),
    params,
  );
  const decision = parseClassifierDecision(decisionResult.content);

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
      agentId: worker.id,
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
      agentId: worker.id,
      disposition: 'hard_skip_type',
      details: {
        node_type: node.type,
        worker_slug: worker.slug,
        hint: `Type '${node.type}' is hard-coded as skip (transient/internal kinds).`,
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
      agentId: worker.id,
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
      agentId: worker.id,
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
      agentId: worker.id,
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
      agentId: worker.id,
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

  const body = await readNodeBody(node);
  if (!body || body.trim().length < 20) {
    // Not enough content to extract meaningfully.
    await recordSkippedTrace({
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      agentId: worker.id,
      disposition: 'body_too_short',
      details: {
        worker_slug: worker.slug,
        node_type: node.type,
        title: node.title,
        body_chars: body?.length ?? 0,
        threshold_chars: 20,
        hint: 'The extractor wants ≥20 chars of body content. Title-only nodes are skipped.',
      },
    });
    return;
  }

  const client = new OpenRouter({
    apiKey,
    httpReferer: 'https://mantle.crossworks.network',
    appTitle: 'Mantle',
  });

  console.log(
    `[extractor] node ${node.id.slice(0, 8)} (${node.type}, ${node.title.slice(0, 40)}) via ${worker.model}`,
  );

  const embeddingModel = params.embedding_model;
  const embedOpts = embeddingModel ? { model: embeddingModel } : undefined;

  await startTrace(
    {
      kind: 'extractor_run',
      ownerId,
      subjectId: node.id,
      subjectKind: 'node',
      // Trace's agentId historically held the extractor's id; we keep
      // the same column populated with the worker id for /traces
      // navigation continuity.
      agentId: worker.id,
      data: {
        nodeType: node.type,
        title: node.title,
        model: worker.model,
        worker_slug: worker.slug,
        embeddingModel: embeddingModel ?? null,
      },
    },
    async () => {
      const systemPrompt = worker.systemPrompt || DEFAULT_EXTRACTOR_PROMPT;
      const userPayload = `Title: ${node.title}\nType: ${node.type}\n\nBody:\n${body.slice(0, 8000)}`;

      const parsed = await step(
        { name: 'llm_extract', kind: 'llm_call', input: { model: worker.model } },
        async (h) => {
          const r = await chatComplete(
            client,
            worker.model,
            systemPrompt,
            userPayload,
            params,
          );
          captureLlmUsage(h, r.raw, worker.model);
          return parseExtractorOutput(r.content, { nodeId: node.id, model: worker.model });
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
          await db
            .update(nodes)
            .set({
              data: {
                ...existingData,
                summary,
                summary_model: worker.model,
                summary_at: new Date().toISOString(),
                entities: uniqueMentions.map((m) => m.name),
              },
              ...(embedding ? { embedding } : {}),
              updatedAt: new Date(),
            })
            .where(eq(nodes.id, node.id));
          h.setMeta({ summaryLength: summary.length, embedded: !!embedding });
        },
      );

      console.log(
        `[extractor]   → content_index: summary (${summary.length}c), ${uniqueMentions.length} entities`,
      );

      // ─── entity reconciliation ───────────────────────────────────────
      const entityIdByName = await step(
        {
          name: 'reconcile_entities',
          kind: 'compute',
          input: { mentions: uniqueMentions.length },
        },
        async (h) => {
          const map = new Map<string, string>();
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
            } catch (err) {
              console.error(
                `[extractor]   entity '${mention.name}' failed:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
          h.setOutput({ matched, created });
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

      const costCap = params.extract_cost_cap_micro_usd ?? null;

      const tally = await step(
        { name: 'process_facts', kind: 'compute', input: { candidates: parsed.facts.length, costCapMicroUsd: costCap } },
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
                client,
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
