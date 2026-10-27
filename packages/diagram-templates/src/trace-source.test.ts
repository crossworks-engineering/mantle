/**
 * A traced drawing's `trace` (schema.ts TraceSource): circuit_trace writes
 * the circuit and the drawing tables it read, as plain data. It is never
 * drawn (the SVG is the same with or without it), it is checked like any
 * field, and a set carries it on the set. Made-up ids only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateMeasurer, render, validate } from './index.ts';

const ROOT = join(import.meta.dirname, '..');
const load = (f: string) =>
  JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, unknown>;
const T1 = '11111111-1111-4111-8111-111111111111';
const trace = { circuit: '10000-001-01', tables: [T1] };

describe('the trace source', () => {
  it('is kept by the check and never drawn', () => {
    for (const f of ['samples/pid-feed-drum.json', 'test/pid-set.json']) {
      const d = load(f);
      const checked = validate('pid', { ...d, trace });
      expect(checked.ok, f).toBe(true);
      if (checked.ok) expect((checked.data as { trace?: unknown }).trace).toEqual(trace);
      const a = render('pid', d, estimateMeasurer);
      const b = render('pid', { ...d, trace }, estimateMeasurer);
      expect(a.ok && b.ok && a.svg === b.svg, f).toBe(true);
    }
  });

  it('is checked like any field', () => {
    const d = load('samples/pid-feed-drum.json');
    for (const bad of [
      'x',
      { circuit: '' },
      { circuit: 'c', tables: ['not a table id!'] },
      { circuit: 'c', tables: Array.from({ length: 41 }, () => T1) },
      { circuit: 'c', tables: [], extra: 1 },
    ]) {
      const r = validate('pid', { ...d, trace: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
