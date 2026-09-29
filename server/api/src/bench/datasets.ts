/**
 * Benchmark datasets, parsed into one shape: haystacks of dated sessions, each
 * with the questions asked against it. A haystack is what one brain holds (a
 * LoCoMo conversation; a LongMemEval question's session history), so every
 * haystack gets its own scratch database.
 *
 * The data files are NOT in this repo. LoCoMo (snap-research/locomo) is
 * CC BY-NC 4.0; LongMemEval (xiaowu0162/LongMemEval) is MIT. `DATA_SOURCES`
 * names where to fetch them; run.ts caches them outside the repo.
 *
 * Pure parsing only, so it unit-tests without a DB or the network.
 */

export type BenchTurn = { speaker: string; text: string };

export type BenchSession = {
  id: string;
  /** When the session happened (UTC). Null when the dataset gives no date. */
  date: Date | null;
  turns: BenchTurn[];
};

export type BenchQuestion = {
  id: string;
  question: string;
  /** The gold answer, as the dataset states it. */
  answer: string;
  /** Dataset question type (LoCoMo: single-hop, …; LongMemEval: question_type). */
  category: string;
  /** When the question is asked (UTC). */
  askedAt: Date | null;
  /** LongMemEval `_abs` questions: the right answer is "not in the history". */
  abstention: boolean;
};

export type Haystack = { id: string; sessions: BenchSession[]; questions: BenchQuestion[] };

export type DatasetName = 'locomo' | 'longmemeval';

export const DATA_SOURCES: Record<DatasetName, { file: string; url: string; license: string }> = {
  locomo: {
    file: 'locomo10.json',
    url: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
    license: 'CC BY-NC 4.0',
  },
  longmemeval: {
    file: 'longmemeval_s_cleaned.json',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
    license: 'MIT',
  },
};

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** LoCoMo's "1:56 pm on 8 May, 2023" → UTC Date. Null when it doesn't parse. */
export function parseLocomoDate(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\s*$/i.exec(
    s,
  );
  if (!m) return null;
  const month = MONTHS.indexOf(m[5]!.toLowerCase());
  if (month < 0) return null;
  let hour = Number(m[1]) % 12;
  if (m[3]!.toLowerCase() === 'pm') hour += 12;
  return new Date(Date.UTC(Number(m[6]), month, Number(m[4]), hour, Number(m[2])));
}

/** LongMemEval's "2023/05/30 (Tue) 23:40" → UTC Date. Null when it doesn't parse. */
export function parseLongMemEvalDate(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]+\))?\s+(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])),
  );
}

const LOCOMO_CATEGORIES: Record<number, string> = {
  1: 'single-hop',
  2: 'temporal',
  3: 'multi-hop',
  4: 'open-domain',
};

type LocomoTurn = { speaker?: string; text?: string; blip_caption?: string };
type LocomoItem = {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: Array<{ question: string; answer?: unknown; category: number }>;
};

/**
 * LoCoMo: one haystack per conversation. Category 5 (adversarial) is left out,
 * as every published LoCoMo number does (1,540 questions remain). Questions
 * are asked after the last session. A shared image becomes its caption.
 */
export function parseLocomo(raw: unknown): Haystack[] {
  if (!Array.isArray(raw)) throw new Error('locomo: expected a JSON array');
  return (raw as LocomoItem[]).map((item) => {
    const conv = item.conversation;
    const keys = Object.keys(conv)
      .filter((k) => /^session_\d+$/.test(k) && Array.isArray(conv[k]))
      .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
    const sessions: BenchSession[] = keys.map((k) => ({
      id: `${item.sample_id}_${k}`,
      date: parseLocomoDate(conv[`${k}_date_time`]),
      turns: (conv[k] as LocomoTurn[]).map((t) => ({
        speaker: t.speaker ?? 'Unknown',
        text: [t.text ?? '', t.blip_caption ? `[shares a photo: ${t.blip_caption}]` : '']
          .filter(Boolean)
          .join(' '),
      })),
    }));
    const lastDate = [...sessions].reverse().find((s) => s.date)?.date ?? null;
    const questions: BenchQuestion[] = item.qa
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => LOCOMO_CATEGORIES[q.category])
      .map(({ q, i }) => ({
        id: `${item.sample_id}_q${i}`,
        question: q.question,
        answer: String(q.answer ?? ''),
        category: LOCOMO_CATEGORIES[q.category]!,
        askedAt: lastDate,
        abstention: false,
      }));
    return { id: item.sample_id, sessions, questions };
  });
}

type LongMemEvalItem = {
  question_id: string;
  question_type: string;
  question: string;
  answer: unknown;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
};

/** LongMemEval: one haystack per question (each has its own history). */
export function parseLongMemEval(raw: unknown): Haystack[] {
  if (!Array.isArray(raw)) throw new Error('longmemeval: expected a JSON array');
  return (raw as LongMemEvalItem[]).map((item) => ({
    id: item.question_id,
    sessions: item.haystack_sessions.map((turns, i) => ({
      id: item.haystack_session_ids[i] ?? `${item.question_id}_s${i}`,
      date: parseLongMemEvalDate(item.haystack_dates[i]),
      turns: turns.map((t) => ({
        speaker: t.role === 'assistant' ? 'Assistant' : 'User',
        text: t.content,
      })),
    })),
    questions: [
      {
        id: item.question_id,
        question: item.question,
        answer: String(item.answer ?? ''),
        category: item.question_type,
        askedAt: parseLongMemEvalDate(item.question_date),
        abstention: item.question_id.endsWith('_abs'),
      },
    ],
  }));
}

export function parseDataset(name: DatasetName, raw: unknown): Haystack[] {
  return name === 'locomo' ? parseLocomo(raw) : parseLongMemEval(raw);
}

/**
 * Pick a subset (pure): the first `haystacks` haystacks, or, with `perCategory`,
 * up to that many questions of each category, taken in file order so a sample
 * is reproducible. `questions` caps the questions kept per haystack.
 */
export function selectHaystacks(
  all: readonly Haystack[],
  opts: { haystacks?: number; questions?: number; perCategory?: number; only?: string[] },
): Haystack[] {
  let hs = opts.only?.length ? all.filter((h) => opts.only!.includes(h.id)) : [...all];
  if (opts.perCategory && opts.perCategory > 0) {
    const taken = new Map<string, number>();
    hs = hs
      .map((h) => ({
        ...h,
        questions: h.questions.filter((q) => {
          const n = taken.get(q.category) ?? 0;
          if (n >= opts.perCategory!) return false;
          taken.set(q.category, n + 1);
          return true;
        }),
      }))
      .filter((h) => h.questions.length > 0);
  }
  if (opts.haystacks && opts.haystacks > 0) hs = hs.slice(0, opts.haystacks);
  if (opts.questions && opts.questions > 0)
    hs = hs.map((h) => ({ ...h, questions: h.questions.slice(0, opts.questions) }));
  return hs;
}
