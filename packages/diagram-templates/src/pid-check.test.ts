/**
 * The image check counts a `pid` canvas stores (templates/pid/check.ts,
 * canvas.ts withHonestImageChecks, the one recount path): every save
 * recounts them from the drawing's own marks, so no saved canvas keeps a
 * count its marks do not hold. A canvas whose count already matches, or
 * that is no pid canvas, comes back byte for byte. The seal check here
 * accepts every seal, so only the counting is under test (pid-seal.test.ts
 * tests the seals). Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCanvas,
  imageCheckSummary,
  imageChecksStale,
  readCanvasData,
  withHonestImageChecks,
  withImageCheckSummary,
} from './index.ts';

/** Every seal holds: the save's recount alone. */
const recount = (html: string) => withHonestImageChecks(html, () => true);
const provenance = { id: '0123456789abcdef', keys: [], sig: 'a'.repeat(64) };

const mark = (key: string, state: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: 'link',
  state,
  ...extra,
  sig: 'b'.repeat(64),
});

/** One drawing: two guesses, one answered yes. */
const drawing = (checks?: unknown) => ({
  title: 'Marked',
  equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
  offpage: [
    { id: 'OPC-1', direction: 'in', sheet: 'S1', check: mark('k1', 'unchecked') },
    { id: 'OPC-2', direction: 'out', sheet: 'S2', check: mark('k2', 'checked', { answer: 'yes' }) },
  ],
  lines: [
    { from: 'OPC-1', to: 'V-101' },
    { from: 'V-101', to: 'OPC-2' },
  ],
  provenance,
  ...(checks ? { checks } : {}),
});
const FORGED = { guesses: 2, unchecked: 0, checked: 2, unsure: 0, contradicted: 0, corrected: 0 };

describe('a pid canvas keeps the count of its own marks', () => {
  it('a forged count is recounted from the marks; only the data block changes', () => {
    const html = buildCanvas({ template: 'pid', data: drawing(FORGED), mode: 'import' });
    expect(imageChecksStale(readCanvasData(html))).toBe(true);
    const own = recount(html);
    const data = readCanvasData(own) as { checks: Record<string, number> };
    expect(data.checks).toEqual(imageCheckSummary(data));
    expect(data.checks).toMatchObject({ guesses: 2, unchecked: 1, checked: 1 });
    // Everything outside the data block is as it was.
    const outside = (h: string) =>
      h.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '');
    expect(outside(own)).toBe(outside(html));
  });

  it('a missing count is added, a count on unmarked data is dropped', () => {
    const missing = buildCanvas({ template: 'pid', data: drawing(), mode: 'import' });
    const added = readCanvasData(recount(missing)) as { checks?: unknown };
    expect(added.checks).toMatchObject({ guesses: 2, unchecked: 1 });
    const plain = {
      title: 'Hand drawn',
      equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
      offpage: [{ id: 'OPC-1', direction: 'in', sheet: 'S1' }],
      lines: [{ from: 'OPC-1', to: 'V-101' }],
      checks: FORGED,
    };
    const dropped = readCanvasData(
      recount(buildCanvas({ template: 'pid', data: plain, mode: 'import' })),
    );
    expect(dropped.checks).toBeUndefined();
  });

  it('each page of a set is recounted too, each guess once in the total', () => {
    const set = {
      set: true,
      title: 'Set',
      pages: [
        { id: 'p1', title: 'One', data: drawing(FORGED) },
        { id: 'p2', title: 'Two', data: drawing() },
      ],
      provenance,
      checks: FORGED,
    };
    const html = buildCanvas({ template: 'pid', data: set, mode: 'import' });
    const data = readCanvasData(recount(html)) as {
      checks: Record<string, number>;
      pages: { data: { checks: Record<string, number> } }[];
    };
    // The same two keys on both pages: two guesses in all.
    expect(data.checks).toMatchObject({ guesses: 2, unchecked: 1, checked: 1 });
    for (const p of data.pages) expect(p.data.checks).toMatchObject({ guesses: 2, unchecked: 1 });
  });

  it('a count that matches, another template, or a broken data block: byte for byte', () => {
    const honest = buildCanvas({
      template: 'pid',
      data: withImageCheckSummary(drawing()),
      mode: 'import',
    });
    expect(imageChecksStale(readCanvasData(honest))).toBe(false);
    expect(recount(honest)).toBe(honest);
    const flow = buildCanvas({
      template: 'flow',
      data: { title: 'F', nodes: [{ id: 'a', label: 'A' }], edges: [], checks: FORGED },
      mode: 'import',
    });
    expect(recount(flow)).toBe(flow);
    const broken = honest.replace('"checks": {', '"checks": {,,');
    expect(broken).not.toBe(honest);
    expect(recount(broken)).toBe(broken);
    const page = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
    expect(recount(page)).toBe(page);
  });
});
