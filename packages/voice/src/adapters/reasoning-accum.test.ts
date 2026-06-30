import { describe, it, expect } from 'vitest';
import { ReasoningDetailsAccumulator, normalizeReasoningDetails } from './reasoning-accum';

describe('ReasoningDetailsAccumulator', () => {
  it('reassembles a text block split across fragments, signature last', () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ type: 'reasoning.text', index: 0, text: 'Let me ' }]);
    acc.add([{ index: 0, text: 'think about ' }]);
    acc.add([{ index: 0, text: 'this.' }]);
    acc.add([{ index: 0, signature: 'sig-abc', format: 'anthropic' }]);
    expect(acc.result()).toEqual([
      { type: 'reasoning.text', index: 0, text: 'Let me think about this.', signature: 'sig-abc', format: 'anthropic' },
    ]);
  });

  it('keeps multiple blocks in arrival order even with non-contiguous indices', () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ type: 'reasoning.text', index: 2, text: 'first-seen' }]);
    acc.add([{ type: 'reasoning.encrypted', index: 5, data: 'enc' }]);
    const r = acc.result()!;
    expect(r.map((d) => d.index)).toEqual([2, 5]);
    expect(r[0]!.text).toBe('first-seen');
    expect(r[1]!.type).toBe('reasoning.encrypted');
    expect(r[1]!.data).toBe('enc');
  });

  it('concatenates encrypted data fragments (never corrupts the blob)', () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ type: 'reasoning.encrypted', index: 0, data: 'AAAA' }]);
    acc.add([{ index: 0, data: 'BBBB' }]);
    expect(acc.result()![0]!.data).toBe('AAAABBBB');
  });

  it('signature is last-non-null wins (never blanked by a later empty)', () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ type: 'reasoning.text', index: 0, text: 'x', signature: 'real-sig' }]);
    acc.add([{ index: 0, text: 'y', signature: null }]);
    expect(acc.result()![0]!.signature).toBe('real-sig');
  });

  it('is empty / undefined when no fragments arrive', () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add(undefined);
    acc.add(null);
    acc.add([]);
    expect(acc.isEmpty).toBe(true);
    expect(acc.result()).toBeUndefined();
  });

  it('defaults a missing index to 0 and a missing type to reasoning.text', () => {
    const acc = new ReasoningDetailsAccumulator();
    acc.add([{ text: 'no index here' }]);
    expect(acc.result()).toEqual([{ type: 'reasoning.text', text: 'no index here' }]);
  });
});

describe('normalizeReasoningDetails (one-shot)', () => {
  it('passes a complete array through, dropping junk entries', () => {
    expect(
      normalizeReasoningDetails([
        { type: 'reasoning.text', index: 0, text: 'hi', signature: 's' },
        null,
        'garbage',
        { type: 'reasoning.encrypted', index: 1, data: 'z' },
      ]),
    ).toEqual([
      { type: 'reasoning.text', index: 0, text: 'hi', signature: 's' },
      { type: 'reasoning.encrypted', index: 1, data: 'z' },
    ]);
  });

  it('returns undefined for non-arrays / empties', () => {
    expect(normalizeReasoningDetails(undefined)).toBeUndefined();
    expect(normalizeReasoningDetails([])).toBeUndefined();
    expect(normalizeReasoningDetails('nope')).toBeUndefined();
  });
});
