/**
 * One haystack, end to end, inside its own scratch database (run.ts starts
 * this as a child process with DATABASE_URL pointing at that database):
 *
 *   seed    a brain owner, the OpenRouter key, an extractor worker, the
 *           embedding config and a responder agent (no decider: retrieval
 *           stays deterministic)
 *   ingest  each session as a dated note, then extractNode on each, the
 *           same code the extract queue runs (summary, facts, entities,
 *           relations, passages, embeddings)
 *   answer  loadConversationContext for the question, rendered as the
 *           responder would see it, then one answer call and one judge call
 *
 * Spend: extraction cost is read back from the scratch database's traces;
 * answer and judge cost come from OpenRouter's reported usage. The child
 * stops answering once it passes its cap.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { agents, aiWorkers, db, embeddingConfig, nodes, type Agent } from '@mantle/db';
import { setApiKey } from '@mantle/api-keys';
import { createNote } from '@mantle/content';
import { clearEmbeddingModelCache } from '@mantle/embeddings';
import { loadConversationContext, resolveRouteAdapter } from '@mantle/runtime/agent';
import { extractNode } from '../agent/extractor';
import { renderContext } from './context';
import type { BenchQuestion, DatasetName, Haystack } from './datasets';
import {
  answerPrompt,
  extractFinalAnswer,
  judgePrompt,
  parseVerdict,
  sessionToNote,
} from './prompts';

export type BenchModels = {
  answer: string;
  judge: string;
  extractor: string;
  embedding: string;
};

export type QuestionResult = {
  query_id: string;
  category: string;
  question: string;
  gold: string;
  response: string;
  answer: string;
  correct: boolean | null;
  judge_raw: string;
  context_chars: number;
  retrieve_ms: number;
  answer_usd: number;
  judge_usd: number;
  error?: string;
};

export type HaystackResult = {
  id: string;
  sessions: number;
  extracted: number;
  extract_failed: number;
  ingest_ms: number;
  extract_usd: number;
  questions: QuestionResult[];
  stopped_for_budget: boolean;
  total_usd: number;
};

async function seedBrain(
  models: BenchModels,
  apiKey: string,
): Promise<{ ownerId: string; agent: Agent }> {
  const ownerId = randomUUID();
  await db.execute(sql`
    insert into auth.users (id, email, password_hash, is_owner, role)
    values (${ownerId}, ${`bench-${ownerId}@bench.invalid`}, 'x', true, 'admin')
  `);
  await setApiKey(ownerId, 'openrouter', 'default', apiKey);
  await db.insert(aiWorkers).values({
    ownerId,
    slug: 'extractor',
    name: 'Extractor',
    kind: 'extractor',
    provider: 'openrouter',
    model: models.extractor,
    params: { extract_facts: true },
    isDefault: true,
  });
  await db.insert(embeddingConfig).values({
    ownerId,
    model: models.embedding,
    dimensions: 768,
    primaryProvider: 'openrouter',
  });
  clearEmbeddingModelCache(ownerId);
  const [agent] = await db
    .insert(agents)
    .values({
      ownerId,
      slug: 'assistant',
      name: 'Assistant',
      role: 'responder',
      provider: 'openrouter',
      model: models.answer,
      systemPrompt: '',
      // Empty = the code defaults, which match what onboarding seeds.
      memoryConfig: {},
    })
    .returning();
  if (!agent) throw new Error('bench: agent insert returned no row');
  return { ownerId, agent };
}

async function ingest(
  ownerId: string,
  haystack: Haystack,
  concurrency: number,
  maxUsd: number,
): Promise<{ extracted: number; failed: number; stopped: boolean }> {
  const ids: string[] = [];
  for (const [i, session] of haystack.sessions.entries()) {
    const note = await createNote(ownerId, {
      ...sessionToNote(session, i),
      tags: ['bench-session'],
    });
    // Date the node when the session happened: recency ranking reads it.
    if (session.date) {
      await db
        .update(nodes)
        .set({ createdAt: session.date, updatedAt: session.date })
        .where(eq(nodes.id, note.id));
    }
    ids.push(note.id);
  }
  let extracted = 0;
  let failed = 0;
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < ids.length && !stopped) {
      // The spend cap holds during ingest too: check it every few notes.
      if (next > 0 && next % 5 === 0 && (await tracedSpendUsd(ownerId)) >= maxUsd) {
        stopped = true;
        break;
      }
      const id = ids[next++]!;
      try {
        await extractNode(id, ownerId);
        extracted++;
      } catch (err) {
        failed++;
        console.error(`[bench] extract failed for ${id}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { extracted, failed, stopped };
}

async function tracedSpendUsd(ownerId: string): Promise<number> {
  const rows = (await db.execute(
    sql`select coalesce(sum(cost_micro_usd), 0)::bigint as micro from traces where owner_id = ${ownerId}`,
  )) as unknown as Array<{ micro: string | number }>;
  return Number(rows[0]?.micro ?? 0) / 1e6;
}

type Call = { text: string; usd: number };

async function callModel(
  ownerId: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<Call> {
  const route = await resolveRouteAdapter(ownerId, {
    provider: 'openrouter',
    model,
    apiKeyId: null,
    baseUrl: null,
    viaTailnet: false,
  });
  const res = await route.adapter.chat({
    apiKey: route.apiKey,
    model: route.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    maxTokens,
    maxRetries: 3,
  });
  return { text: res.text ?? '', usd: res.reportedCostUsd ?? 0 };
}

async function askOne(
  dataset: DatasetName,
  ownerId: string,
  agent: Agent,
  models: BenchModels,
  q: BenchQuestion,
): Promise<QuestionResult> {
  const base = {
    query_id: q.id,
    category: q.category,
    question: q.question,
    gold: q.answer,
  };
  const t0 = performance.now();
  const ctx = await loadConversationContext({ ownerId, agent, inboundText: q.question });
  const context = renderContext(ctx, models.answer);
  const retrieveMs = Math.round(performance.now() - t0);
  const prompt = answerPrompt(q, context);
  const answered = await callModel(ownerId, models.answer, prompt.system, prompt.user, 8000);
  const answer = extractFinalAnswer(answered.text);
  // The judge grades the final answer, as the published harnesses do.
  const judged = await callModel(
    ownerId,
    models.judge,
    'You are a careful grader. Follow the instructions exactly.',
    judgePrompt(dataset, q, answer),
    400,
  );
  return {
    ...base,
    response: answered.text,
    answer,
    correct: parseVerdict(dataset, judged.text),
    judge_raw: judged.text,
    context_chars: context.length,
    retrieve_ms: retrieveMs,
    answer_usd: answered.usd,
    judge_usd: judged.usd,
  };
}

export async function runHaystack(opts: {
  dataset: DatasetName;
  haystack: Haystack;
  models: BenchModels;
  apiKey: string;
  maxUsd: number;
  extractConcurrency: number;
  /** Ingest and extract, ask nothing: a cheap run for extraction checks. */
  ingestOnly?: boolean;
}): Promise<HaystackResult> {
  const { dataset, haystack, models } = opts;
  const { ownerId, agent } = await seedBrain(models, opts.apiKey);
  const t0 = performance.now();
  const ingested = await ingest(ownerId, haystack, opts.extractConcurrency, opts.maxUsd);
  const { extracted, failed } = ingested;
  const ingestMs = Math.round(performance.now() - t0);
  const extractUsd = await tracedSpendUsd(ownerId);
  let spent = extractUsd;
  const questions: QuestionResult[] = [];
  let stopped = ingested.stopped;
  for (const q of opts.ingestOnly ? [] : haystack.questions) {
    if (stopped || spent >= opts.maxUsd) {
      stopped = true;
      break;
    }
    try {
      const r = await askOne(dataset, ownerId, agent, models, q);
      spent += r.answer_usd + r.judge_usd;
      questions.push(r);
    } catch (err) {
      questions.push({
        query_id: q.id,
        category: q.category,
        question: q.question,
        gold: q.answer,
        response: '',
        answer: '',
        correct: null,
        judge_raw: '',
        context_chars: 0,
        retrieve_ms: 0,
        answer_usd: 0,
        judge_usd: 0,
        error: (err as Error).message,
      });
    }
  }
  return {
    id: haystack.id,
    sessions: haystack.sessions.length,
    extracted,
    extract_failed: failed,
    ingest_ms: ingestMs,
    extract_usd: extractUsd,
    questions,
    stopped_for_budget: stopped,
    total_usd: spent,
  };
}
