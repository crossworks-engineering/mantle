/**
 * The page asks of one file (./pdf-kind.ts pdfPageDeciderOf; plan page
 * c607711a, M3 in shadow), with stand-ins for its guards, the decider and
 * the answer cache:
 *  - the two checks of the file (model work, page asks on here): either "no"
 *    gives no asker, so no picture is drawn or sent (the Q5 guard);
 *  - an answer kept in the answer cache is taken with no call (an extract
 *    tried again pays for no page twice), and a new one is kept;
 *  - the room of the day cap;
 *  - 3 failures in a row, or the breaker open, say `stop`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kept: new Map<string, unknown>(),
  keeps: 0,
}));
vi.mock('@mantle/db/answer-cache', async (orig) => ({
  ...(await orig<typeof import('@mantle/db/answer-cache')>()),
  keptAnswer: vi.fn(async (key: string) => h.kept.get(key) ?? null),
  keepAnswer: vi.fn(async (_kind: string, key: string, answer: unknown) => {
    h.keeps += 1;
    h.kept.set(key, answer);
  }),
}));

const { pdfPageDeciderOf, PAGE_ASK_FAILURES_STOP } = await import('./pdf-kind');
type Deps = import('./pdf-kind').PdfPageDeciderDeps;

const ASK = {
  page: 3,
  picture: 'page-3.jpg',
  size: 'a1',
  class: 'vector_text',
  instrument_tags: 14,
  line_numbers: 6,
  tag_like_tokens: 40,
  text_sample: 'P&ID UNIT 100',
};
const ANSWER = { kind: 'pid', confidence: 0.97, sure: true, model: 'm', mode: 'shadow' as const };

/** The stand-ins: the guards, a decider that answers or fails, the cap. */
function deps(over: Partial<Deps> & { answer?: 'ok' | 'fail' | 'skip' } = {}) {
  const calls: unknown[] = [];
  const d: Partial<Deps> = {
    allowed: async () => true,
    on: async () => true,
    dayCap: () => 100,
    today: async () => 40,
    decide: (async (_o: string, fields: unknown, _p: Buffer, batch?: any) => {
      calls.push(fields);
      if (over.answer === 'fail') batch.failed += 1;
      if (over.answer === 'skip') batch.skipped += 1;
      return over.answer && over.answer !== 'ok' ? null : ANSWER;
    }) as Deps['decide'],
    ...over,
  };
  return { d, calls };
}

beforeEach(() => {
  h.kept.clear();
  h.keeps = 0;
});

describe('the page asks of a file', () => {
  it('no model work for the file, or page asks off on this box: no asker at all', async () => {
    expect(await pdfPageDeciderOf('o', 'n', deps({ allowed: async () => false }).d)).toBeNull();
    expect(await pdfPageDeciderOf('o', 'n', deps({ on: async () => false }).d)).toBeNull();
    expect(await pdfPageDeciderOf('o', 'n', deps().d)).not.toBeNull();
  });

  it('the room is the day cap less the asks of the last 24 hours', async () => {
    const asker = await pdfPageDeciderOf('o', 'n', deps().d);
    expect(await asker!.room()).toBe(60);
    const full = await pdfPageDeciderOf('o', 'n', deps({ today: async () => 500 }).d);
    expect(await full!.room()).toBe(0);
    // A count that cannot be read: no room.
    const lost = await pdfPageDeciderOf(
      'o',
      'n',
      deps({ today: async () => Promise.reject(new Error('db down')) }).d,
    );
    expect(await lost!.room()).toBe(0);
  });

  it('an answer is kept, and taken again with no call; the picture name is not what is asked', async () => {
    const { d, calls } = deps();
    const asker = await pdfPageDeciderOf('o', 'n', d);
    expect(await asker!.ask(ASK, Buffer.from('pixels'))).toEqual(ANSWER);
    expect(h.keeps).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('picture');
    // The same bytes and fields: the kept answer, no call.
    const again = await pdfPageDeciderOf('o', 'n', d);
    expect(await again!.ask(ASK, Buffer.from('pixels'))).toEqual(ANSWER);
    expect(calls).toHaveLength(1);
    // Other bytes: a new ask.
    await again!.ask(ASK, Buffer.from('other pixels'));
    expect(calls).toHaveLength(2);
  });

  it(`${PAGE_ASK_FAILURES_STOP} failures in a row say stop; an open breaker says stop at once`, async () => {
    const failing = await pdfPageDeciderOf('o', 'n', deps({ answer: 'fail' }).d);
    const outs: unknown[] = [];
    for (let i = 0; i < PAGE_ASK_FAILURES_STOP; i++) {
      outs.push(
        await failing!.ask(
          { ...ASK, page: i + 1, picture: `page-${i + 1}.jpg` },
          Buffer.from(`p${i}`),
        ),
      );
    }
    expect(outs).toEqual([null, null, 'stop']);
    expect(h.keeps).toBe(0);
    const open = await pdfPageDeciderOf('o', 'n', deps({ answer: 'skip' }).d);
    expect(await open!.ask(ASK, Buffer.from('p'))).toBe('stop');
  });
});
