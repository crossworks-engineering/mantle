import { describe, expect, it } from 'vitest';
import {
  locomoEvidence,
  parseLocomo,
  parseLocomoDate,
  parseLongMemEval,
  parseLongMemEvalDate,
  selectHaystacks,
  type Haystack,
} from './datasets';
import {
  answerPrompt,
  evidenceFound,
  extractFinalAnswer,
  judgePrompt,
  parseVerdict,
  saidMissing,
  sessionToNote,
} from './prompts';
import { estimateRun, renderReport, summarize } from './report';
import type { HaystackResult, QuestionResult } from './haystack';

const MODELS = {
  answer: 'google/gemini-3.1-pro-preview',
  judge: 'google/gemini-2.5-flash-lite',
  extractor: 'google/gemini-3.5-flash-lite',
  embedding: 'openai/text-embedding-3-large',
};

describe('dates', () => {
  it('parses LoCoMo and LongMemEval date strings as UTC', () => {
    expect(parseLocomoDate('1:56 pm on 8 May, 2023')?.toISOString()).toBe(
      '2023-05-08T13:56:00.000Z',
    );
    expect(parseLocomoDate('12:05 am on 1 January, 2024')?.toISOString()).toBe(
      '2024-01-01T00:05:00.000Z',
    );
    expect(parseLongMemEvalDate('2023/05/30 (Tue) 23:40')?.toISOString()).toBe(
      '2023-05-30T23:40:00.000Z',
    );
    expect(parseLocomoDate('garbage')).toBeNull();
    expect(parseLongMemEvalDate(undefined)).toBeNull();
  });
});

describe('parseLocomo', () => {
  const raw = [
    {
      sample_id: 'conv-1',
      conversation: {
        speaker_a: 'Ann',
        speaker_b: 'Bob',
        session_2: [{ speaker: 'Bob', dia_id: 'D2:1', text: 'Back from Rome.' }],
        session_2_date_time: '9:00 am on 10 May, 2023',
        session_1: [
          { speaker: 'Ann', dia_id: 'D1:1', text: 'Hi!' },
          { speaker: 'Bob', dia_id: 'D1:2', text: 'Look', blip_caption: 'a dog on a beach' },
        ],
        session_1_date_time: '1:56 pm on 8 May, 2023',
      },
      qa: [
        { question: 'Where was Bob?', answer: 'Rome', category: 1, evidence: ['D2:1'] },
        { question: 'Trick?', adversarial_answer: 'x', category: 5 },
        { question: 'How many?', answer: 2, category: 3 },
      ],
    },
  ];

  it('orders sessions, keeps captions, drops adversarial questions, asks after the last session', () => {
    const [h] = parseLocomo(raw);
    expect(h!.sessions.map((s) => s.id)).toEqual(['conv-1_session_1', 'conv-1_session_2']);
    expect(h!.sessions[0]!.turns[1]!.text).toBe('Look [shares a photo: a dog on a beach]');
    expect(h!.questions.map((q) => [q.id, q.category, q.answer])).toEqual([
      ['conv-1_q0', 'single-hop', 'Rome'],
      ['conv-1_q2', 'multi-hop', '2'],
    ]);
    expect(h!.questions[0]!.askedAt?.toISOString()).toBe('2023-05-10T09:00:00.000Z');
    expect(h!.questions[0]!.evidence).toEqual([1]);
    expect(h!.questions[1]!.evidence).toEqual([]);
  });

  it('reads packed evidence strings and ignores sessions that do not exist', () => {
    const keys = ['session_1', 'session_2', 'session_3', 'session_10'];
    expect(locomoEvidence(['D8:6; D3:17', 'D1:1 D1:2'], keys)).toEqual([0, 2]);
    expect(locomoEvidence(['D10:4'], keys)).toEqual([3]);
    expect(locomoEvidence(undefined, keys)).toEqual([]);
  });
});

describe('parseLongMemEval', () => {
  it('makes one haystack per question and flags abstention questions', () => {
    const hs = parseLongMemEval([
      {
        question_id: 'q1_abs',
        question_type: 'multi-session',
        question: 'What car?',
        answer: 'Not mentioned',
        question_date: '2023/06/01 (Thu) 10:00',
        haystack_session_ids: ['s1'],
        answer_session_ids: ['s1', 'gone'],
        haystack_dates: ['2023/05/30 (Tue) 23:40'],
        haystack_sessions: [
          [
            { role: 'user', content: 'I bought a bike.' },
            { role: 'assistant', content: 'Nice.' },
          ],
        ],
      },
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.sessions[0]!.turns.map((t) => t.speaker)).toEqual(['User', 'Assistant']);
    expect(hs[0]!.questions[0]!.abstention).toBe(true);
    expect(hs[0]!.questions[0]!.evidence).toEqual([0]);
  });
});

describe('selectHaystacks', () => {
  const hs: Haystack[] = ['a', 'b', 'c'].map((id) => ({
    id,
    sessions: [],
    questions: ['x', 'y', 'x'].map((category, i) => ({
      id: `${id}${i}`,
      question: '?',
      answer: '!',
      category,
      askedAt: null,
      abstention: false,
      evidence: [],
    })),
  }));

  it('limits haystacks and questions per haystack', () => {
    const out = selectHaystacks(hs, { haystacks: 2, questions: 1 });
    expect(out.map((h) => h.questions.map((q) => q.id))).toEqual([['a0'], ['b0']]);
  });

  it('samples per category in file order, dropping haystacks left empty', () => {
    const out = selectHaystacks(hs, { perCategory: 2 });
    expect(out.map((h) => h.questions.map((q) => q.id))).toEqual([['a0', 'a1', 'a2'], ['b1']]);
  });
});

describe('prompts', () => {
  it('puts the session date in the note title and first line', () => {
    const note = sessionToNote(
      {
        id: 's',
        date: new Date(Date.UTC(2023, 4, 8, 13, 56)),
        turns: [{ speaker: 'Ann', text: 'Hi' }],
      },
      0,
    );
    expect(note.title).toBe('Conversation 1, Monday 8 May 2023, 1:56 pm UTC');
    expect(note.content.split('\n')[0]).toBe(
      'Conversation held on Monday 8 May 2023, 1:56 pm UTC.',
    );
    expect(note.content).toContain('Ann: Hi');
  });

  it('states the question date and the context in the answer prompt', () => {
    const p = answerPrompt(
      {
        id: 'q',
        question: 'When?',
        answer: '',
        category: 'temporal',
        askedAt: new Date(Date.UTC(2023, 5, 1)),
        abstention: false,
        evidence: [],
      },
      'CTX',
    );
    expect(p.system).toContain('Thursday 1 June 2023');
    expect(p.system).toContain('CTX');
    expect(p.user).toBe('When?');
  });

  it('takes the final answer line, or the whole text when there is none', () => {
    expect(extractFinalAnswer('1. a\n2. b\nAnswer: two')).toBe('two');
    expect(extractFinalAnswer('**Answer:** Rome')).toBe('Rome');
    expect(extractFinalAnswer('Rome')).toBe('Rome');
  });

  it('builds the published judge prompts', () => {
    const q = {
      id: 'q',
      question: 'Where?',
      answer: 'Rome',
      category: 'temporal-reasoning',
      askedAt: null,
      abstention: false,
      evidence: [],
    };
    expect(judgePrompt('locomo', q, 'In Rome')).toContain('Gold answer: Rome');
    expect(judgePrompt('longmemeval', q, 'x')).toContain('do not penalize off-by-one errors');
    expect(judgePrompt('longmemeval', { ...q, abstention: true }, 'x')).toContain(
      'unanswerable question',
    );
    expect(
      judgePrompt('longmemeval', { ...q, category: 'single-session-preference' }, 'x'),
    ).toContain('Rubric: Rome');
  });

  it('counts evidence sessions by note title, without prefix clashes', () => {
    const ctx = '• "Conversation 11, Monday 1 May 2023" …\n— from "Conversation 2, Friday":';
    expect(evidenceFound(ctx, [1])).toBe(1); // Conversation 2
    expect(evidenceFound(ctx, [0])).toBe(0); // Conversation 1 is not Conversation 11
    expect(evidenceFound(ctx, [10, 1, 4])).toBe(2);
  });

  it('spots an answer that says the memory lacks it', () => {
    expect(saidMissing('The memory does not contain the answer.')).toBe(true);
    expect(saidMissing('This is not mentioned in the conversations.')).toBe(true);
    expect(saidMissing("I can't determine that from the memory.")).toBe(true);
    expect(saidMissing('Sweden')).toBe(false);
    expect(saidMissing('She moved from Sweden, as she mentioned.')).toBe(false);
  });

  it('reads verdicts, and returns null when the judge gave none', () => {
    expect(parseVerdict('locomo', 'Same city. {"label": "CORRECT"}')).toBe(true);
    expect(parseVerdict('locomo', '{"label":"WRONG"}')).toBe(false);
    expect(parseVerdict('locomo', 'CORRECT or WRONG?')).toBeNull();
    expect(parseVerdict('longmemeval', 'Yes.')).toBe(true);
    expect(parseVerdict('longmemeval', 'no')).toBe(false);
    expect(parseVerdict('longmemeval', 'maybe')).toBeNull();
  });
});

describe('report', () => {
  const q = (
    category: string,
    correct: boolean | null,
    error?: string,
    evidence: { sessions: number[]; found: number; missing?: boolean } = { sessions: [], found: 0 },
  ): QuestionResult => ({
    query_id: category,
    category,
    question: '?',
    gold: '!',
    response: '',
    answer: '',
    correct,
    judge_raw: '',
    context_chars: 400,
    context: 'ctx',
    evidence_sessions: evidence.sessions,
    evidence_found: evidence.found,
    said_missing: evidence.missing ?? false,
    retrieve_ms: 100,
    answer_usd: 0.01,
    judge_usd: 0.001,
    error,
  });
  const result: HaystackResult = {
    id: 'h',
    sessions: 2,
    extracted: 2,
    extract_failed: 0,
    ingest_ms: 4000,
    ingest_loop_delay_ms: { p50: 20, p99: 30, max: 40 },
    extract_usd: 0.05,
    questions: [
      q('a', true, undefined, { sessions: [0], found: 1 }),
      q('a', false, undefined, { sessions: [0, 2], found: 1, missing: true }),
      q('b', null, undefined, { sessions: [3], found: 1 }),
      q('b', null, 'boom'),
    ],
    stopped_for_budget: false,
    total_usd: 0.094,
  };

  it('counts errors and unreadable verdicts as wrong', () => {
    const s = summarize('locomo', MODELS, [result], { requested: 1, stoppedForBudget: false });
    expect(s.total_queries).toBe(4);
    expect(s.correct).toBe(1);
    expect(s.accuracy).toBe(0.25);
    expect(s.errors).toBe(1);
    expect(s.unjudged).toBe(1);
    expect(s.by_category.a).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
    expect(s.evidence).toMatchObject({ labelled: 3, all_found: 2 });
    expect(s.evidence.by_category.a).toEqual({ labelled: 2, all_found: 1, rate: 0.5 });
    expect(s.misses).toEqual({
      wrong: 3,
      retrieval_miss: 1,
      answer_miss: 1,
      unlabelled: 1,
      said_missing: 1,
    });
    expect(renderReport(s)).toContain('**Accuracy: 25.0%**');
    expect(renderReport(s)).toContain('1 retrieval misses');
  });

  it('estimates a run from its sessions and questions', () => {
    const h: Haystack = {
      id: 'h',
      sessions: [{ id: 's', date: null, turns: [{ speaker: 'A', text: 'x'.repeat(4000) }] }],
      questions: [
        {
          id: 'q',
          question: '?',
          answer: '!',
          category: 'c',
          askedAt: null,
          abstention: false,
          evidence: [],
        },
      ],
    };
    const e = estimateRun([h], MODELS);
    expect(e.usd).toBeGreaterThan(0);
    expect(e.text).toMatch(/^about \$/);
  });
});
