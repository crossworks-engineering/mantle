/**
 * Every traced drawing both checks and draws: random sheets (seeded, so
 * every run is the same) traced, checked with the `pid` template and laid
 * out with the estimate measurer, page by page. A page whose layout throws
 * would draw as an error panel and fail pid_check; here it fails the test.
 * The seeds listed first are ones whose pages once threw. All drawings are
 * made up.
 */
import { describe, expect, it } from 'vitest';
import { estimateMeasurer, render, validate } from '@mantle/diagram-templates';
import { CIRCUIT, randomSheet, seeded } from './fixtures';
import { traceCircuit, type SheetInput } from './walk';

/** One random circuit: one to three sheets of up to 12 lines (60 on every
 *  fifth seed). */
function circuitFor(seed: number): SheetInput[] {
  const rnd = seeded(seed);
  const n = 1 + Math.floor(rnd() * 3);
  return Array.from({ length: n }, (_, i) =>
    randomSheet(rnd, seed % 5 === 0 ? 60 : 12, `PID-${1001 + i}`, `t${i}`),
  );
}

/** Seeds whose drawings once threw in the layout: a bypass whose two tees
 *  landed on one point, a connector placed on its own tee. */
const ONCE_THREW = [235, 2405, 3691];
const SEEDS = [...ONCE_THREW, ...Array.from({ length: 150 }, (_, i) => i + 1)];

describe('a traced circuit checks and draws', () => {
  it(`${SEEDS.length} seeded random circuits: no check error, no page that fails to draw`, () => {
    const problems: string[] = [];
    let pages = 0;
    for (const seed of SEEDS) {
      const { pid } = traceCircuit(CIRCUIT, circuitFor(seed));
      const checked = validate('pid', pid);
      if (!checked.ok) {
        problems.push(`seed ${seed}: check: ${checked.errors[0]}`);
        continue;
      }
      const r = render('pid', pid, estimateMeasurer);
      if (!r.ok) {
        problems.push(`seed ${seed}: ${r.errors[0]}`);
        continue;
      }
      for (const f of r.failed ?? []) problems.push(`seed ${seed}: ${f.path}: ${f.error}`);
      pages += r.pages?.length ?? 1;
    }
    expect(problems).toEqual([]);
    expect(pages).toBeGreaterThan(SEEDS.length);
  }, 60_000);
});
