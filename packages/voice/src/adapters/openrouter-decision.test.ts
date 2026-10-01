/**
 * Wire-shape tests for the OpenRouter decision adapter. The endpoint is alpha,
 * so the request body and the answer mapping are pinned here: a shape change
 * upstream fails this test rather than silently returning "no decision" on
 * every call in production.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDecisionBody,
  normaliseAnswer,
  openrouterDecisionAdapter,
} from './openrouter-decision';

const QUESTIONS = {
  team: {
    type: 'choice' as const,
    instructions: 'Which team should own `ticket`?',
    criteria: { billing: 'Charges and refunds', technical: 'Bugs and outages' },
  },
  urgency: {
    type: 'score' as const,
    instructions: 'How urgent is `ticket`?',
    criteria: ['Can wait', 'This week', 'Blocking now'],
  },
  is_bug: { type: 'noul' as const, instructions: 'Does `ticket` report a defect?' },
};

const WIRE_OK = {
  id: 'gen-dec-1',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
  answers: {
    team: {
      type: 'choice',
      choice: 'technical',
      confidence: 0.75,
      probabilities: { billing: 0.16, technical: 0.84 },
    },
    urgency: {
      type: 'score',
      score: 1.99,
      confidence: 0.99,
      probabilities: { '0': 0, '1': 0.01, '2': 0.99 },
      legend: { '0': 'Can wait', '1': 'This week', '2': 'Blocking now' },
    },
    is_bug: { type: 'noul', noul: 0.96 },
  },
};

describe('buildDecisionBody', () => {
  it('sends model + state + questions and asks for zero data retention by default', () => {
    const body = buildDecisionBody({
      apiKey: 'k',
      model: 'typesafe/jev-1.13',
      state: { ticket: 'Checkout is blank' },
      questions: QUESTIONS,
    });
    expect(body).toEqual({
      model: 'typesafe/jev-1.13',
      state: { ticket: 'Checkout is blank' },
      questions: QUESTIONS,
      provider: { zdr: true, data_collection: 'deny' },
    });
  });

  it('omits the provider block only when zeroDataRetention is explicitly false', () => {
    const body = buildDecisionBody({
      apiKey: 'k',
      model: 'm',
      state: 's',
      questions: QUESTIONS,
      zeroDataRetention: false,
    });
    expect(body.provider).toBeUndefined();
  });
});

describe('normaliseAnswer', () => {
  it('maps the three wire shapes', () => {
    expect(normaliseAnswer({ type: 'noul', noul: 0.4 })).toEqual({
      type: 'noul',
      probability: 0.4,
    });
    expect(normaliseAnswer(WIRE_OK.answers.team as never)).toEqual({
      type: 'choice',
      choice: 'technical',
      confidence: 0.75,
      probabilities: { billing: 0.16, technical: 0.84 },
    });
    const score = normaliseAnswer(WIRE_OK.answers.urgency as never);
    expect(score).toMatchObject({ type: 'score', score: 1.99, confidence: 0.99 });
  });

  it('returns null for an unknown or incomplete shape', () => {
    expect(normaliseAnswer(undefined)).toBeNull();
    expect(normaliseAnswer({ type: 'choice' } as never)).toBeNull();
    expect(normaliseAnswer({ type: 'weird' } as never)).toBeNull();
  });
});

describe('openrouterDecisionAdapter.decide', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the alpha decisions endpoint and returns typed answers + usage', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(WIRE_OK), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await openrouterDecisionAdapter.decide({
      apiKey: 'sk-test',
      model: 'typesafe/jev-1.13',
      state: { ticket: 'Checkout is blank' },
      questions: QUESTIONS,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(res.model).toBe('typesafe/jev-1.13-20260917');
    expect(res.tokensIn).toBe(476);
    expect(res.reportedCostUsd).toBeCloseTo(0.000019992, 9);
    expect(res.answers.team).toMatchObject({ type: 'choice', choice: 'technical' });
    expect(res.answers.is_bug).toEqual({ type: 'noul', probability: 0.96 });
  });

  it('throws on a non-200 with the provider message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }), {
            status: 402,
          }),
      ),
    );
    await expect(
      openrouterDecisionAdapter.decide({
        apiKey: 'k',
        model: 'm',
        state: 's',
        questions: QUESTIONS,
      }),
    ).rejects.toThrow(/402: Insufficient credits/);
  });

  it('throws when a declared question has no usable answer', async () => {
    const partial = { ...WIRE_OK, answers: { team: WIRE_OK.answers.team } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(partial), { status: 200 })),
    );
    await expect(
      openrouterDecisionAdapter.decide({
        apiKey: 'k',
        model: 'm',
        state: 's',
        questions: QUESTIONS,
      }),
    ).rejects.toThrow(/no usable answer for question 'urgency'/);
  });
});
