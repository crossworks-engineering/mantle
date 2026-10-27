/**
 * The circuit rules circuit_trace applies (walk.ts) against the golden
 * cases the parser's CAD tier is held to as well
 * (packages/files/src/dwg-circuit-rules.golden.json; the Python half is
 * server/parser/cad/tests/test_rules_golden.py). The two sides used to
 * copy the rules by hand; this file and its Python twin are what keeps them
 * one rule.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_TAG,
  EXTENT_TRIM,
  LINE_TAG,
  NEAR_REL,
  parseCircuitLayer,
  trimmedDiagonal,
} from './walk';

type LayerCase = {
  layer: string;
  circuit: string | null;
  role?: 'main' | 'deadleg';
  kind?: 'circuit' | 'injection point';
  parent?: string;
};
type Seg4 = [number, number, number, number];
type ExtentCase = {
  about: string;
  segments?: Seg4[];
  segmentsGenerated?: { count: number; dx: number; length: number };
  stray?: Seg4;
  diag: number;
};
const golden = JSON.parse(
  readFileSync(
    new URL('../../../files/src/dwg-circuit-rules.golden.json', import.meta.url),
    'utf8',
  ),
) as {
  nearRel: number;
  extentTrim: number;
  layers: LayerCase[];
  lineTags: { match: string[]; noMatch: string[] };
  circuitTags: { match: string[]; noMatch: string[] };
  extent: ExtentCase[];
};

describe('the circuit rules match the golden cases', () => {
  it('the near ratio and the extent trim', () => {
    expect(NEAR_REL).toBe(golden.nearRel);
    expect(EXTENT_TRIM).toBe(golden.extentTrim);
  });

  it.each(golden.layers.map((c) => [c.layer, c] as const))('layer %j', (_l, c) => {
    const p = parseCircuitLayer(c.layer);
    if (c.circuit === null) {
      expect(p).toBeNull();
      return;
    }
    expect(p).not.toBeNull();
    expect({
      circuit: p!.circuit,
      role: p!.role,
      kind: p!.parent ? 'injection point' : 'circuit',
      parent: p!.parent,
    }).toEqual({ circuit: c.circuit, role: c.role, kind: c.kind, parent: c.parent });
  });

  it('line-number and circuit attribute tags', () => {
    for (const t of golden.lineTags.match) expect(LINE_TAG.test(t), t).toBe(true);
    for (const t of golden.lineTags.noMatch) expect(LINE_TAG.test(t), t).toBe(false);
    for (const t of golden.circuitTags.match) expect(CIRCUIT_TAG.test(t), t).toBe(true);
    for (const t of golden.circuitTags.noMatch) expect(CIRCUIT_TAG.test(t), t).toBe(false);
  });

  it.each(golden.extent.map((c) => [c.about, c] as const))('extent: %s', (_a, c) => {
    const rows: Seg4[] = c.segments
      ? [...c.segments]
      : Array.from({ length: c.segmentsGenerated!.count }, (_, i): Seg4 => {
          const g = c.segmentsGenerated!;
          return [i * g.dx, 0, i * g.dx, g.length];
        });
    if (c.stray) rows.push(c.stray);
    const segs = rows.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));
    expect(trimmedDiagonal(segs)).toBeCloseTo(c.diag, 9);
  });
});
