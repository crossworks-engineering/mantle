import { beforeEach, describe, expect, it, vi } from 'vitest';

// decide() end to end, with its edges stubbed: the worker, its key, the
// tracing step and the decision endpoint. The endpoint answers per call
// from `h.plan`: 'ok' answers, 'fail' rejects.
const h = vi.hoisted(() => ({
  plan: [] as Array<'ok' | 'fail'>,
  sent: 0,
  states: [] as Array<{ message?: string }>,
}));

vi.mock('@mantle/db', () => ({
  getDefaultWorker: vi.fn(async () => ({
    id: 'w1',
    provider: 'openrouter',
    model: 'jev',
    apiKeyId: 'k1',
    params: { uses: { journal_recall: { enabled: true }, passage_scoring: { enabled: true } } },
  })),
  bumpWorkerUsage: vi.fn(async () => {}),
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: vi.fn(async () => 'key'),
  getApiKey: vi.fn(async () => 'key'),
}));
vi.mock('@mantle/tracing', () => ({
  recordChatUsage: vi.fn(),
  step: vi.fn(async (_o: unknown, fn: (h: unknown) => unknown) =>
    fn({ setMeta: vi.fn(), setOutput: vi.fn(), setSkipped: vi.fn() }),
  ),
}));
vi.mock('@mantle/voice', () => ({
  getDecisionAdapter: () => ({
    decide: vi.fn(
      async (req: { questions: Record<string, unknown>; state: { message?: string } }) => {
        h.states.push(req.state);
        const outcome = h.plan[h.sent++] ?? 'ok';
        if (outcome === 'fail') throw new Error('timeout');
        return {
          model: 'jev',
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
  clearDecisionCache();
  forgetResolvedDecider();
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
