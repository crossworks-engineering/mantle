/**
 * Several pipes between the same two pieces of equipment, one way and the
 * other. A layout that failed on such pipes is retried with one ranking
 * edge per pair (pid-layout-guard.test.ts draws it); a drawing that laid
 * out before must draw byte for byte as it did, so the retry never touches
 * it. The pin below was made with the renderer before the retry existed
 * (v0.400.4). A hash that moves is a regression, not a test to update.
 * Tags are made up.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { estimateMeasurer, render } from './index.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

// Two parallel pipes from E-3 to E-1 and a pair between E-2 and E-4, one
// each way: these laid out before, and the merged ranking moved them.
const data = {
  title: 'Parallel and reversed lines',
  equipment: ['vertical-vessel', 'centrifugal-pump', 'filter', 'tank', 'exchanger'].map(
    (type, i) => ({ id: `E-${i}`, type }),
  ),
  offpage: [
    { id: 'OPC-1', direction: 'in', sheet: 'A' },
    { id: 'OPC-2', direction: 'out', sheet: 'B' },
  ],
  lines: [
    { id: 'L1', from: 'OPC-1', to: 'E-0' },
    { id: 'L2', from: 'E-0', to: 'E-1' },
    { id: 'L3', from: 'E-1', to: 'E-2' },
    { id: 'L4', from: 'E-2', to: 'E-3' },
    { id: 'L5', from: 'E-3', to: 'OPC-2' },
    { id: 'L7', from: 'E-3', to: 'E-1' },
    { id: 'L8', from: 'E-3', to: 'E-1' },
    { id: 'L9', from: 'E-4', to: 'E-2' },
    { id: 'L10', from: 'E-2', to: 'E-4' },
  ],
};

describe('parallel and reversed pipes between two pieces', () => {
  it('draw exactly as before the pair-edge retry', () => {
    const r = render('pid', data, estimateMeasurer);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    for (const id of ['L7', 'L8', 'L9', 'L10']) expect(r.svg).toContain(`data-line="${id}"`);
    expect(hash(r.svg)).toBe('b9f99a0857de06f47cb59943');
  });
});
