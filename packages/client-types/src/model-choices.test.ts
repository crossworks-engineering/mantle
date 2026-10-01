import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_MODEL_CHOICES,
  WORKER_MODEL_CHOICES,
  formatUsdPerM,
  templatePrice,
} from './model-choices';

describe('formatUsdPerM', () => {
  it('rounds float noise from per-token × 1e6 to cents', () => {
    expect(formatUsdPerM(0.13199999999999998)).toBe('$0.13');
    expect(formatUsdPerM(0.5279999999999999)).toBe('$0.53');
    expect(formatUsdPerM(2.0547999999999997)).toBe('$2.05');
    expect(formatUsdPerM(1.5999999999999999)).toBe('$1.60');
  });

  it('drops .00 on whole dollars, like the hand-written heads', () => {
    expect(formatUsdPerM(2)).toBe('$2');
    expect(formatUsdPerM(15)).toBe('$15');
    expect(formatUsdPerM(0)).toBe('$0');
  });

  it('keeps two significant figures under a cent instead of $0.00', () => {
    expect(formatUsdPerM(0.0075)).toBe('$0.0075');
    expect(formatUsdPerM(0.001234)).toBe('$0.0012');
  });

  it('marks an unknown side', () => {
    expect(formatUsdPerM(null)).toBe('?');
    expect(templatePrice({ inputPerM: 0.14, outputPerM: null })).toBe('$0.14 · ? /M');
  });
});

describe('shipped model cards', () => {
  it('never show a price with float noise', () => {
    const noisy = [...ASSISTANT_MODEL_CHOICES, ...WORKER_MODEL_CHOICES]
      .filter((c) => /\d\.\d{5,}/.test(c.price))
      .map((c) => `${c.name}: ${c.price}`);
    expect(noisy).toEqual([]);
  });
});
