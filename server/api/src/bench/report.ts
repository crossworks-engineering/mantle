/**
 * Benchmark bookkeeping (pure): the up-front cost estimate, the run summary
 * and the markdown report. Accuracy counts every attempted question: an error
 * or an unreadable verdict counts as wrong, never as skipped.
 */
import type { Haystack, DatasetName } from './datasets';
import type { BenchModels, HaystackResult } from './haystack';
import { sessionToNote } from './prompts';

/** USD per million tokens, [input, output]. Checked against OpenRouter's
 *  catalog on 2026-09-29; an unknown model estimates at the answer default's
 *  price, so an estimate errs high rather than low. */
const PRICES: Record<string, [number, number]> = {
  'google/gemini-3.1-pro-preview': [2, 12],
  'google/gemini-2.5-flash-lite': [0.1, 0.4],
  'google/gemini-3.5-flash-lite': [0.3, 2.5],
  'google/gemini-3.5-flash': [1.5, 9],
  'openai/text-embedding-3-large': [0.13, 0],
};
const price = (model: string): [number, number] => PRICES[model] ?? [2, 12];
const usd = (model: string, tokIn: number, tokOut: number) =>
  (price(model)[0] * tokIn + price(model)[1] * tokOut) / 1e6;

/** Assumptions per call, in tokens (chars / 4). The extractor's prompt is
 *  about 3k tokens and reads at most 8k chars of body; the fact classifier
 *  adds about half again. The answer reads about 22k chars of context and
 *  thinks before it answers. */
const EXTRACT_PROMPT_TOK = 3000;
const EXTRACT_OUT_TOK = 900;
const CLASSIFIER_OVERHEAD = 1.5;
const ANSWER_CONTEXT_TOK = 6000;
const ANSWER_OUT_TOK = 1500;
const JUDGE_IN_TOK = 700;
const JUDGE_OUT_TOK = 80;

export function estimateRun(
  haystacks: readonly Haystack[],
  models: BenchModels,
): { usd: number; text: string } {
  let extract = 0;
  let embed = 0;
  let answer = 0;
  let judge = 0;
  for (const h of haystacks) {
    for (const [i, s] of h.sessions.entries()) {
      const body = sessionToNote(s, i).content.length;
      extract += usd(
        models.extractor,
        (EXTRACT_PROMPT_TOK + Math.min(body, 8000) / 4) * CLASSIFIER_OVERHEAD,
        EXTRACT_OUT_TOK * CLASSIFIER_OVERHEAD,
      );
      embed += usd(models.embedding, body / 4, 0);
    }
    for (const q of h.questions) {
      answer += usd(
        models.answer,
        ANSWER_CONTEXT_TOK + q.question.length / 4 + 400,
        ANSWER_OUT_TOK,
      );
      judge += usd(models.judge, JUDGE_IN_TOK, JUDGE_OUT_TOK);
    }
  }
  const total = extract + embed + answer + judge;
  return {
    usd: total,
    text:
      `about $${total.toFixed(2)} (ingest $${(extract + embed).toFixed(2)}, ` +
      `answer $${answer.toFixed(2)}, judge $${judge.toFixed(2)})`,
  };
}

type Tally = { n: number; correct: number; accuracy: number };

export type BenchSummary = {
  dataset: DatasetName;
  models: BenchModels;
  /** The responder's memory_config for the run ({} = code defaults). */
  memory_config: Record<string, unknown>;
  answer_style: string;
  haystacks: { requested: number; completed: number };
  stopped_for_budget: boolean;
  total_queries: number;
  correct: number;
  accuracy: number;
  by_category: Record<string, Tally>;
  errors: number;
  unjudged: number;
  /** Did the sessions holding the answer reach the context? Counted over
   *  questions the dataset labels, by title in the context (a lower bound). */
  evidence: {
    labelled: number;
    all_found: number;
    all_found_rate: number;
    by_category: Record<string, { labelled: number; all_found: number; rate: number }>;
  };
  /** Wrong answers, split by cause. retrieval_miss: some evidence session
   *  never reached the context. answer_miss: all of it did, and the answer
   *  was still wrong. unlabelled: the dataset names no evidence. */
  misses: {
    wrong: number;
    retrieval_miss: number;
    answer_miss: number;
    unlabelled: number;
    said_missing: number;
  };
  avg_context_chars: number;
  avg_context_tokens_est: number;
  avg_retrieve_ms: number;
  ingest: { sessions: number; extracted: number; failed: number; avg_haystack_ms: number };
  spend_usd: { extract: number; answer: number; judge: number; total: number };
};

const tally = (n: number, correct: number): Tally => ({
  n,
  correct,
  accuracy: n ? correct / n : 0,
});

export function summarize(
  dataset: DatasetName,
  models: BenchModels,
  results: readonly HaystackResult[],
  meta: {
    requested: number;
    stoppedForBudget: boolean;
    memoryConfig?: Record<string, unknown>;
    answerStyle?: string;
  },
): BenchSummary {
  const qs = results.flatMap((r) => r.questions);
  const byCat = new Map<string, { n: number; correct: number }>();
  for (const q of qs) {
    const t = byCat.get(q.category) ?? { n: 0, correct: 0 };
    t.n++;
    if (q.correct) t.correct++;
    byCat.set(q.category, t);
  }
  const correct = qs.filter((q) => q.correct).length;
  const labelled = qs.filter((q) => !q.error && q.evidence_sessions?.length);
  const allFound = (q: (typeof qs)[number]) => q.evidence_found === q.evidence_sessions.length;
  const evByCat = new Map<string, { labelled: number; all_found: number }>();
  for (const q of labelled) {
    const t = evByCat.get(q.category) ?? { labelled: 0, all_found: 0 };
    t.labelled++;
    if (allFound(q)) t.all_found++;
    evByCat.set(q.category, t);
  }
  const wrong = qs.filter((q) => !q.correct);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const ctx = qs.filter((q) => !q.error).map((q) => q.context_chars);
  const extract = results.reduce((n, r) => n + r.extract_usd, 0);
  const answer = qs.reduce((n, q) => n + q.answer_usd, 0);
  const judge = qs.reduce((n, q) => n + q.judge_usd, 0);
  return {
    dataset,
    models,
    memory_config: meta.memoryConfig ?? {},
    answer_style: meta.answerStyle ?? 'infer',
    haystacks: { requested: meta.requested, completed: results.length },
    stopped_for_budget: meta.stoppedForBudget || results.some((r) => r.stopped_for_budget),
    total_queries: qs.length,
    correct,
    accuracy: qs.length ? correct / qs.length : 0,
    by_category: Object.fromEntries(
      [...byCat.entries()].sort().map(([k, t]) => [k, tally(t.n, t.correct)]),
    ),
    errors: qs.filter((q) => q.error).length,
    unjudged: qs.filter((q) => !q.error && q.correct === null).length,
    evidence: {
      labelled: labelled.length,
      all_found: labelled.filter(allFound).length,
      all_found_rate: labelled.length ? labelled.filter(allFound).length / labelled.length : 0,
      by_category: Object.fromEntries(
        [...evByCat.entries()]
          .sort()
          .map(([k, t]) => [k, { ...t, rate: t.labelled ? t.all_found / t.labelled : 0 }]),
      ),
    },
    misses: {
      wrong: wrong.length,
      retrieval_miss: wrong.filter((q) => q.evidence_sessions?.length && !allFound(q)).length,
      answer_miss: wrong.filter((q) => q.evidence_sessions?.length && allFound(q)).length,
      unlabelled: wrong.filter((q) => !q.evidence_sessions?.length).length,
      said_missing: wrong.filter((q) => q.said_missing).length,
    },
    avg_context_chars: Math.round(avg(ctx)),
    avg_context_tokens_est: Math.round(avg(ctx) / 4),
    avg_retrieve_ms: Math.round(avg(qs.filter((q) => !q.error).map((q) => q.retrieve_ms))),
    ingest: {
      sessions: results.reduce((n, r) => n + r.sessions, 0),
      extracted: results.reduce((n, r) => n + r.extracted, 0),
      failed: results.reduce((n, r) => n + r.extract_failed, 0),
      avg_haystack_ms: Math.round(avg(results.map((r) => r.ingest_ms))),
    },
    spend_usd: { extract, answer, judge, total: extract + answer + judge },
  };
}

/** Published AMB numbers (vectorize-io/agent-memory-benchmark results
 *  manifest, 2026-09): same answer and judge models, their own answer prompt.
 *  Context only; a sample run is not comparable to a full one. */
const REFERENCES: Record<DatasetName, Array<[string, number, number]>> = {
  locomo: [
    ['Hindsight', 0.92, 36235],
    ['hybrid-search baseline', 0.791, 22157],
  ],
  longmemeval: [
    ['Hindsight', 0.946, 43625],
    ['hybrid-search baseline', 0.74, 23222],
  ],
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderReport(s: BenchSummary): string {
  const lines = [
    `# ${s.dataset} run`,
    '',
    `**Accuracy: ${pct(s.accuracy)}** (${s.correct}/${s.total_queries}; ` +
      `${s.haystacks.completed}/${s.haystacks.requested} haystacks` +
      `${s.stopped_for_budget ? ', STOPPED AT THE SPEND CAP' : ''})`,
    '',
    `Errors ${s.errors}, unreadable verdicts ${s.unjudged} (both count as wrong).`,
    '',
    '| Category | Questions | Correct | Accuracy | Evidence reached the context |',
    '|---|---|---|---|---|',
    ...Object.entries(s.by_category).map(([k, t]) => {
      const ev = s.evidence.by_category[k];
      return `| ${k} | ${t.n} | ${t.correct} | ${pct(t.accuracy)} | ${ev ? pct(ev.rate) : 'n/a'} |`;
    }),
    '',
    `Evidence: for ${pct(s.evidence.all_found_rate)} of labelled questions, every session holding ` +
      'the answer reached the context by title (a lower bound: facts carry no title).',
    `Wrong answers (${s.misses.wrong}): ${s.misses.retrieval_miss} retrieval misses (evidence never ` +
      `reached the context), ${s.misses.answer_miss} answer misses (it did; the answer was still wrong), ` +
      `${s.misses.unlabelled} unlabelled. ${s.misses.said_missing} said the memory lacked the answer.`,
    '',
    `Context per question: ${s.avg_context_chars} chars (about ${s.avg_context_tokens_est} tokens). ` +
      `Retrieval: ${s.avg_retrieve_ms} ms.`,
    `Ingest: ${s.ingest.extracted}/${s.ingest.sessions} sessions extracted (${s.ingest.failed} failed), ` +
      `${Math.round(s.ingest.avg_haystack_ms / 1000)} s per haystack.`,
    `Spend: $${s.spend_usd.total.toFixed(2)} (extract $${s.spend_usd.extract.toFixed(2)}, ` +
      `answer $${s.spend_usd.answer.toFixed(2)}, judge $${s.spend_usd.judge.toFixed(2)}).`,
    '',
    `Models: answer ${s.models.answer}, judge ${s.models.judge}, extractor ${s.models.extractor}, ` +
      `embedding ${s.models.embedding}.`,
    `Settings: memory_config ${JSON.stringify(s.memory_config)} (empty = the defaults), ` +
      `answer prompt ${s.answer_style}.`,
    '',
    '## Published references (AMB, full runs)',
    '',
    '| System | Accuracy | Context tokens |',
    '|---|---|---|',
    ...REFERENCES[s.dataset].map(([n, a, t]) => `| ${n} | ${pct(a)} | ${t} |`),
  ];
  return `${lines.join('\n')}\n`;
}
