import { describe, expect, it } from 'vitest';
import { calculate } from './calculate';

const ok = (expr: string, opts?: Parameters<typeof calculate>[1]) => {
  const r = calculate(expr, opts);
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r;
};
const err = (expr: string, opts?: Parameters<typeof calculate>[1]) => {
  const r = calculate(expr, opts);
  if (r.ok) throw new Error(`expected failure, got: ${r.result}`);
  return r.error;
};

describe('calculate — arithmetic', () => {
  it('evaluates plain expressions', () => {
    expect(ok('2 * (3 + 4)').value).toBe(14);
    expect(ok('sqrt(16)').value).toBe(4);
    expect(ok('2^10').value).toBe(1024);
  });

  it('handles the precision a model would get wrong by hand', () => {
    // The value this session originally mis-stated as 3.174.
    expect(ok('0.61 * 50 * (0.11 / 12) * sqrt(2 * 32.2 * 100 / 50)').value).toBeCloseTo(
      3.1729937,
      6,
    );
  });
});

describe('calculate — units', () => {
  it('adds like quantities and reports the unit', () => {
    const r = ok('2 ft + 3 in');
    expect(r.result).toContain('ft');
    expect(r.value).toBeCloseTo(2.25, 6);
    expect(r.unit).toBeTruthy();
  });

  it('converts on request', () => {
    expect(ok('100 lbf/in^2', { to: 'kPa' }).result).toMatch(/kPa/);
    expect(ok('560 degR', { to: 'degF' }).result).toMatch(/degF/);
  });

  it('recognises g_c as dimensionless', () => {
    expect(ok('32.2 lbm ft/(lbf s^2)').value).toBeCloseTo(1.0008, 4);
  });

  it('computes the release rate WITH units', () => {
    const r = ok(
      '0.61 * 50 lbm/ft^3 * (0.11 in^2 / (12 in/ft)) * ' +
        'sqrt(2 * 32.2 lbm ft/(lbf s^2) * 100 lbf/in^2 / (50 lbm/ft^3))',
      { to: 'lbm/s' },
    );
    expect(r.value).toBeCloseTo(3.173, 3);
  });

  it('refuses a dimensionally impossible request rather than inventing a number', () => {
    expect(err('1 ft + 1 kg')).toMatch(/Units do not match/i);
    expect(err('100 lbf/in^2', { to: 'metre' })).toMatch(/cannot convert/i);
  });
});

describe('calculate — safety', () => {
  it('refuses assignment and function definition', () => {
    expect(err('x = 5')).toMatch(/assignment is not supported/);
    expect(err('f(x) = x^2')).toMatch(/assignment is not supported/);
  });

  it('refuses the escape hatches mathjs itself flags', () => {
    for (const hostile of ['import("fs")', 'evaluate("1+1")', 'createUnit("x")']) {
      expect(err(hostile)).toBeTruthy();
    }
  });

  it('refuses property access into internals', () => {
    expect(err('(1).constructor')).toBeTruthy();
  });

  it('bounds the input', () => {
    expect(err('1 +'.repeat(400) + '1')).toMatch(/too long/);
  });

  it('returns an error rather than throwing, for every bad input', () => {
    for (const bad of ['', '   ', ')(', '@@@', '{']) {
      expect(() => calculate(bad)).not.toThrow();
      expect(calculate(bad).ok).toBe(false);
    }
  });
});
