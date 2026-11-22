/**
 * The page asks of one file (./pdf-kind.ts pdfPageDeciderOf; plan page
 * c607711a, M3 in shadow), with stand-ins for its guards, the decider and
 * the answer cache:
 *  - the two checks of the file (model work, page asks on here): either "no"
 *    gives no asker, so no picture is drawn or sent (the Q5 guard);
 *  - a paid answer is kept in the answer cache, and `kept` reads it back
 *    with no call (an extract tried again pays for no page twice); the key
 *    holds the question (its text and options), not the router's version;
 *  - the room of the day cap;
 *  - 3 nulls in a row (a failure or any other no answer), or the breaker
 *    open, say `stop`.
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
const { PDF_PAGE_QUESTIONS } = await import('@mantle/decisions');
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
function deps(over: Partial<Deps> & { answer?: 'ok' | 'fail' | 'skip' | 'none' } = {}) {
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

  it('a paid answer is kept; kept reads it back with no call; the picture name is not what is asked', async () => {
    const { d, calls } = deps();
    const asker = await pdfPageDeciderOf('o', 'n', d);
    expect(await asker!.kept(ASK, Buffer.from('pixels'))).toBeNull();
    expect(await asker!.ask(ASK, Buffer.from('pixels'))).toEqual(ANSWER);
    expect(h.keeps).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('picture');
    // The same bytes and fields (an extract tried again): kept, no call.
    const again = await pdfPageDeciderOf('o', 'n', d);
    expect(await again!.kept(ASK, Buffer.from('pixels'))).toEqual(ANSWER);
    expect(calls).toHaveLength(1);
    // Other bytes: nothing kept.
    expect(await again!.kept(ASK, Buffer.from('other pixels'))).toBeNull();
  });

  it("the key is the question, not the router's version: a new router keeps it, a new question text or option moves it", async () => {
    const asker = await pdfPageDeciderOf('o', 'n', deps().d);
    await asker!.ask(ASK, Buffer.from('pixels'));
    // No router version goes in (a release with pdf-router 1.3.1 for a
    // rules change is the same key): kept and ask take the ask and the
    // picture only, and a new asker (the retry) finds the answer.
    expect(asker!.kept.length).toBe(2);
    expect(asker!.ask.length).toBe(2);
    const retry = await pdfPageDeciderOf('o', 'n', deps().d);
    expect(await retry!.kept(ASK, Buffer.from('pixels'))).toEqual(ANSWER);
    const question = PDF_PAGE_QUESTIONS.kind!;
    try {
      // A new question text: no kept answer.
      PDF_PAGE_QUESTIONS.kind = {
        ...question,
        instructions: `${question.instructions} Look again.`,
      };
      expect(await retry!.kept(ASK, Buffer.from('pixels'))).toBeNull();
      // A new option: no kept answer.
      const criteria = (question as { criteria: Record<string, string> }).criteria;
      PDF_PAGE_QUESTIONS.kind = { ...question, criteria: { ...criteria, map: 'A map.' } } as never;
      expect(await retry!.kept(ASK, Buffer.from('pixels'))).toBeNull();
    } finally {
      PDF_PAGE_QUESTIONS.kind = question;
    }
    // The same question again: the answer is found.
    expect(await retry!.kept(ASK, Buffer.from('pixels'))).toEqual(ANSWER);
  });

  it(`${PAGE_ASK_FAILURES_STOP} failures in a row say stop; an open breaker says stop at once`, async () => {
    const failing = await pdfPageDeciderOf('o', 'n', deps({ answer: 'fail' }).d);
    expect(await nulls(failing!)).toEqual([null, null, 'stop']);
    expect(h.keeps).toBe(0);
    const open = await pdfPageDeciderOf('o', 'n', deps({ answer: 'skip' }).d);
    expect(await open!.ask(ASK, Buffer.from('p'))).toBe('stop');
  });

  it(`any null counts to the stop: ${PAGE_ASK_FAILURES_STOP} in a row with no failure (over the limits, no picture, no choice) say stop too`, async () => {
    const none = await pdfPageDeciderOf('o', 'n', deps({ answer: 'none' }).d);
    expect(await nulls(none!)).toEqual([null, null, 'stop']);
    // An answer between resets the count.
    let n = 0;
    const mixed = await pdfPageDeciderOf(
      'o',
      'n',
      deps({ decide: (async () => (++n === 2 ? ANSWER : null)) as Deps['decide'] }).d,
    );
    expect(await nulls(mixed!, 4)).toEqual([null, ANSWER, null, null]);
  });
});

/** `count` asks of other pages in a row. */
async function nulls(asker: NonNullable<Awaited<ReturnType<typeof pdfPageDeciderOf>>>, count = 3) {
  const outs: unknown[] = [];
  for (let i = 0; i < count; i++) {
    outs.push(
      await asker.ask({ ...ASK, page: i + 1, picture: `page-${i + 1}.jpg` }, Buffer.from(`p${i}`)),
    );
  }
  return outs;
}
