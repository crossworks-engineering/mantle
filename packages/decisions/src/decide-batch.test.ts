import { beforeEach, describe, expect, it, vi } from 'vitest';

// decide() end to end, with its edges stubbed: the worker, its key, the
// tracing step and the decision endpoint. The endpoint answers per call
// from `h.plan`: 'ok' answers, 'fail' rejects.
const h = vi.hoisted(() => ({
  plan: [] as Array<'ok' | 'fail'>,
  sent: 0,
  states: [] as Array<{ message?: string }>,
  timeouts: [] as number[],
  privacies: [] as unknown[],
  params: {} as Record<string, unknown>,
  model: 'jev',
  tokensIn: 0,
}));

vi.mock('@mantle/db', () => ({
  getDefaultWorker: vi.fn(async () => ({
    id: 'w1',
    provider: 'openrouter',
    model: h.model,
    apiKeyId: 'k1',
    params: {
      ...h.params,
      uses: { journal_recall: { enabled: true }, passage_scoring: { enabled: true } },
    },
  })),
  bumpWorkerUsage: vi.fn(async () => {}),
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: vi.fn(async () => 'key'),
  getApiKey: vi.fn(async () => 'key'),
  resolveProviderKey: vi.fn(async () => 'key'),
}));
vi.mock('@mantle/tracing', () => ({
  contextLimitFor: () => null,
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  step: vi.fn(async (_o: unknown, fn: (h: unknown) => unknown) =>
    fn({ setMeta: vi.fn(), setOutput: vi.fn(), setSkipped: vi.fn() }),
  ),
}));
vi.mock('@mantle/voice', () => ({
  getDecisionAdapter: () => ({
    decide: vi.fn(
      async (req: {
        questions: Record<string, unknown>;
        state: { message?: string };
        timeoutMs: number;
        privacy?: unknown;
      }) => {
        h.states.push(req.state);
        h.privacies.push(req.privacy);
        h.timeouts.push(req.timeoutMs);
        const outcome = h.plan[h.sent++] ?? 'ok';
        if (outcome === 'fail') throw new Error('timeout');
        return {
          model: 'jev',
          tokensIn: h.tokensIn,
          answers: Object.fromEntries(
            Object.keys(req.questions).map((k) => [
              k,
              { type: 'score', score: 2, confidence: 0.9, probabilities: {} },
            ]),
          ),
        };
      },
    ),
  }),
}));

import { clearDecisionCache, decide, forgetResolvedDecider } from './decide';
import { scoreInGroups, MAX_MESSAGE_CHARS } from './group-scoring';

const fanOut = (message: string, n: number) =>
  scoreInGroups({
    ownerId: 'o1',
    use: 'journal_recall',
    message,
    previousExchange: null,
    items: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: `rule ${i} ${message}` })),
    groupSize: 1,
    itemsKey: 'rules',
    keyPrefix: 'r',
    capChars: 500,
    instructions: () => 'score',
    levels: () => ['0', '1', '2', '3'],
    defaultThreshold: 1.5,
  });

const single = (message: string) =>
  decide({
    ownerId: 'o1',
    use: 'passage_scoring',
    state: { message },
    questions: { q: { type: 'noul', instructions: 'x' } as never },
  });

beforeEach(() => {
  h.plan = [];
  h.sent = 0;
  h.states = [];
  h.timeouts = [];
  h.privacies = [];
  h.params = {};
  h.model = 'jev';
  h.tokensIn = 0;
  clearDecisionCache();
  forgetResolvedDecider();
});

describe('timeout', () => {
  const call = (message: string, timeoutFactor?: number) =>
    decide({
      ownerId: 'o1',
      use: 'passage_scoring',
      state: { message },
      questions: { q: { type: 'noul', instructions: 'x' } as never },
      ...(timeoutFactor ? { timeoutFactor } : {}),
    });

  it('uses the worker timeout, scaled by timeoutFactor and capped at 5 s', async () => {
    await call('one');
    await call('two', 2);
    await call('ten', 10);
    expect(h.timeouts).toEqual([1500, 3000, 5000]);
  });
});

describe('privacy', () => {
  it('a worker with no privacy setting sends zdr, as before', async () => {
    await single('private');
    expect(h.privacies).toEqual(['zdr']);
  });

  it('the old zdr: false reaches the adapter as no_training', async () => {
    h.params = { zdr: false };
    await single('public');
    expect(h.privacies).toEqual(['no_training']);
  });
});

describe('breaker and fan-outs', () => {
  it('a slow tail in one fan-out does not open the breaker', async () => {
    // 10 groups answer, the last 3 time out: the endpoint is up.
    h.plan = [...Array(10).fill('ok'), 'fail', 'fail', 'fail'];
    const r = await fanOut('a', 13);
    expect(r).toMatchObject({ calls: 13, failed: 3, skipped: 0 });
    const before = h.sent;
    expect(await single('next')).not.toBeNull();
    expect(h.sent).toBe(before + 1);
  });

  it('a fan-out where every group fails counts as ONE failure', async () => {
    h.plan = Array(6).fill('fail');
    expect(await fanOut('b', 3)).toBeNull();
    expect(await fanOut('c', 3)).toBeNull();
    // Two failed decisions: still closed, the next call goes out.
    h.plan.push('ok');
    expect(await single('still up')).not.toBeNull();
  });

  it('three failed decisions in a row still open it, and the open breaker skips groups', async () => {
    h.plan = Array(9).fill('fail');
    await fanOut('d', 3);
    await fanOut('e', 3);
    await fanOut('f', 3);
    const sent = h.sent;
    const r = await fanOut('g', 3);
    expect(r).toBeNull();
    expect(h.sent).toBe(sent);
    expect(await single('blocked')).toBeNull();
  });

  it('caps the message each group carries', async () => {
    await scoreInGroups({
      ownerId: 'o1',
      use: 'journal_recall',
      message: 'x'.repeat(MAX_MESSAGE_CHARS * 3),
      previousExchange: null,
      items: [
        { id: 'a', text: 'rule a' },
        { id: 'b', text: 'rule b' },
      ],
      groupSize: 1,
      itemsKey: 'rules',
      keyPrefix: 'r',
      capChars: 500,
      instructions: () => 'score',
      levels: () => ['0', '1'],
      defaultThreshold: 1,
    });
    expect(h.states).toHaveLength(2);
    for (const st of h.states) expect(st.message).toHaveLength(MAX_MESSAGE_CHARS);
  });
});

describe('request limits', () => {
  const many = (n: number) =>
    decide({
      ownerId: 'o1',
      use: 'passage_scoring',
      state: { message: 'm' },
      questions: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `q${i}`,
          { type: 'noul', instructions: 'x' } as never,
        ]),
      ),
    });

  it('an untested model gets the careful limits: 17 questions are not sent', async () => {
    expect(await many(17)).toBeNull();
    expect(h.sent).toBe(0);
    expect(await many(16)).not.toBeNull();
    expect(h.sent).toBe(1);
  });

  it('a tested model with no known limit keeps the request as the use built it', async () => {
    h.model = '~typesafe/jev-latest';
    expect(await many(60)).not.toBeNull();
    expect(h.sent).toBe(1);
  });

  it('a request above the token limit is not sent, and the breaker does not hear it', async () => {
    const big = () =>
      decide({
        ownerId: 'o1',
        use: 'passage_scoring',
        state: { message: 'x'.repeat(60_000) },
        questions: { q: { type: 'noul', instructions: 'x' } as never },
      });
    for (let i = 0; i < 4; i++) expect(await big()).toBeNull();
    expect(h.sent).toBe(0);
    expect(await single('small')).not.toBeNull();
  });

  it('a reply that reports exactly the token limit is a suspected cut: no answer, one failure', async () => {
    h.model = 'cloudflare/clef-flash';
    h.tokensIn = 16_384;
    expect(await single('cut 1')).toBeNull();
    expect(await single('cut 2')).toBeNull();
    expect(await single('cut 3')).toBeNull();
    // Three failures in a row opened the breaker: the next call is skipped.
    const sent = h.sent;
    h.tokensIn = 1_000;
    expect(await single('after')).toBeNull();
    expect(h.sent).toBe(sent);
  });

  it('the planner splits a fan-out to the careful question limit', async () => {
    const r = await scoreInGroups({
      ownerId: 'o1',
      use: 'journal_recall',
      message: 'm',
      previousExchange: null,
      items: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, text: `rule ${i}` })),
      groupSize: 40,
      itemsKey: 'rules',
      keyPrefix: 'r',
      capChars: 500,
      instructions: () => 'score',
      levels: () => ['0', '1'],
      defaultThreshold: 1,
    });
    expect(r).toMatchObject({ calls: 3, failed: 0 });
    expect(r?.scores.size).toBe(40);
  });
});
