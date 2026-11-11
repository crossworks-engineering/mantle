import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, any>>,
  outcome: null as null | Record<string, any>,
}));

vi.mock('./decide', () => ({
  decide: vi.fn(async (input: Record<string, any>) => {
    h.calls.push(input);
    return h.outcome;
  }),
}));

import { decidePdfKind, PDF_KIND_CRITERIA, type PdfKindState } from './pdf-kind';

const state = (text_sample: string): PdfKindState => ({
  pages: 1,
  page_classes: { vector_text: 1 },
  page_sizes: { a1: 1 },
  instrument_tags: 4,
  line_numbers: 0,
  tag_like_tokens: 12,
  text_sample,
});
const SAMPLE = 'GENERAL ARRANGEMENT OF A MADE UP VESSEL NOZZLE SCHEDULE DESIGN DATA';
const outcome = (choice: string, confidence: number, mode: 'shadow' | 'live') => ({
  answers: { kind: { type: 'choice', choice, confidence, probabilities: {} } },
  mode,
  use: { enabled: true, mode, threshold: undefined, deferBelow: 0.6, actAloneAt: 0.9 },
  model: 'typesafe/jev',
  cached: false,
  ms: 300,
});

beforeEach(() => {
  h.calls.length = 0;
  h.outcome = null;
});

describe('decidePdfKind', () => {
  it('asks one choice question with the small state, and nothing else', async () => {
    h.outcome = outcome('equipment_drawing', 0.93, 'live');
    const got = await decidePdfKind('owner', state(SAMPLE));
    expect(got).toEqual({
      kind: 'equipment_drawing',
      confidence: 0.93,
      model: 'typesafe/jev',
      mode: 'live',
      used: true,
    });
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.use).toBe('pdf_kind');
    expect(call.ownerId).toBe('owner');
    expect(call.state).toEqual(state(SAMPLE));
    expect(Object.keys(call.questions)).toEqual(['kind']);
    expect(call.questions.kind.type).toBe('choice');
    expect(call.questions.kind.criteria).toBe(PDF_KIND_CRITERIA);
  });

  it('every state field is named in the instructions (the model reads literally)', async () => {
    h.outcome = outcome('pid', 0.9, 'live');
    await decidePdfKind('owner', state(SAMPLE));
    const text = h.calls[0]!.questions.kind.instructions as string;
    for (const field of Object.keys(state(''))) expect(text).toContain(`\`${field}\``);
  });

  it('a shadow answer and a weak one are recorded and not used', async () => {
    h.outcome = outcome('pid', 0.95, 'shadow');
    expect(await decidePdfKind('owner', state(SAMPLE))).toMatchObject({ kind: 'pid', used: false });
    h.outcome = outcome('pid', 0.59, 'live');
    expect(await decidePdfKind('owner', state(SAMPLE))).toMatchObject({ kind: 'pid', used: false });
    h.outcome = outcome('pid', 0.6, 'live');
    expect(await decidePdfKind('owner', state(SAMPLE))).toMatchObject({ kind: 'pid', used: true });
  });

  it('too little text to judge: no call', async () => {
    h.outcome = outcome('pid', 0.95, 'live');
    expect(await decidePdfKind('owner', state('  A1  '))).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('no answer, an option it was not given, or another answer type: null', async () => {
    expect(await decidePdfKind('owner', state(SAMPLE))).toBeNull();
    h.outcome = outcome('invoice', 0.99, 'live');
    expect(await decidePdfKind('owner', state(SAMPLE))).toBeNull();
    h.outcome = {
      ...outcome('pid', 0.9, 'live'),
      answers: { kind: { type: 'noul', probability: 1 } },
    };
    expect(await decidePdfKind('owner', state(SAMPLE))).toBeNull();
    // An inherited name is not an option.
    h.outcome = outcome('toString', 0.99, 'live');
    expect(await decidePdfKind('owner', state(SAMPLE))).toBeNull();
  });
});
