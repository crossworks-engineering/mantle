/**
 * Sealed image check marks (templates/pid/check.ts honestImageChecks,
 * canvas.ts withHonestImageChecks): a save keeps a mark only as
 * circuit_trace sealed it, under a sealed provenance; any other claim is
 * made unchecked with its evidence stripped, a drawing without a
 * provenance shows no check at all, and a guess whose mark was dropped
 * still counts. The seal check is a stand-in HMAC under a test key (the
 * real one is the content layer's). Synthetic data only.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCanvas,
  dataBlockCount,
  honestImageChecks,
  imageCheckSummary,
  markSealBody,
  provenanceSealBody,
  readCanvasData,
  validate,
  withHonestImageChecks,
} from './index.ts';

const seal = (body: string, key = 'test-key') =>
  createHmac('sha256', key).update(body).digest('hex');
const holds = (body: string, sig: string) => seal(body) === sig;

const PROV = '0123456789abcdef';
type Mark = Record<string, unknown>;
const signed = (c: Mark, id = PROV, key?: string): Mark => ({
  ...c,
  sig: seal(markSealBody(id, c), key),
});
const provenance = (keys: string[], id = PROV) => ({
  id,
  keys,
  sig: seal(provenanceSealBody({ id, keys })),
});

const yes = {
  key: 'g2',
  kind: 'link',
  state: 'checked',
  guess: 'on S2',
  question: 'Does it go on S2?',
  answer: 'yes',
  reason: 'a connector says so',
  crops: ['crop1'],
  overview: 'ov1',
};
const fresh = { key: 'g1', kind: 'end', state: 'unchecked', guess: 'near V-9' };

/** One traced drawing: g1 unchecked, g2 checked, and the provenance. */
function traced(marks: Mark[] = [signed(fresh), signed(yes)], keys = ['g1', 'g2', 'g3']) {
  return {
    title: 'Traced',
    equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
    offpage: [
      { id: 'OPC-1', direction: 'in', sheet: 'S1', check: marks[0] },
      { id: 'OPC-2', direction: 'out', sheet: 'S2', check: marks[1] },
    ],
    lines: [
      { from: 'OPC-1', to: 'V-101' },
      { from: 'V-101', to: 'OPC-2' },
    ],
    provenance: provenance(keys),
  } as Record<string, unknown>;
}
const marksOf = (d: unknown) =>
  (d as { offpage: { check: Record<string, unknown> }[] }).offpage.map((o) => o.check);

describe('a save keeps only sealed marks', () => {
  it('a genuine traced drawing comes back as the same object, and validates', () => {
    const d = traced();
    expect(honestImageChecks(d, holds)).toBe(d);
    expect(validate('pid', d).ok).toBe(true);
    // g3 is listed and has no mark: it still counts, unchecked.
    expect(imageCheckSummary(d)).toMatchObject({ guesses: 3, unchecked: 2, checked: 1 });
  });

  it('a mark changed by hand, moved from another trace, or not listed is made unchecked', () => {
    for (const bad of <Mark[]>[
      { ...signed(yes), reason: 'typed' },
      { ...signed({ ...yes, state: 'unsure', answer: 'unsure' }), state: 'checked', answer: 'yes' },
      signed(yes, 'fedcba9876543210'),
      signed({ ...yes, key: 'g9' }),
      signed(yes, PROV, 'another-key'),
      { ...yes },
    ]) {
      const out = honestImageChecks(traced([signed(fresh), bad]), holds);
      expect(marksOf(out)[1]).toEqual({
        key: bad.key,
        kind: 'link',
        state: 'unchecked',
        guess: 'on S2',
      });
      expect(marksOf(out)[0]).toEqual(signed(fresh));
    }
  });

  it('without a sealed provenance every mark is unchecked, with no evidence', () => {
    const forged = { ...traced(), provenance: { ...provenance(['g1', 'g2']), keys: ['g1'] } };
    const none = { ...traced() };
    delete none.provenance;
    for (const d of [forged, none]) {
      const out = honestImageChecks(d, holds) as Record<string, unknown>;
      expect(out.provenance).toBeUndefined();
      expect(marksOf(out)).toEqual([
        { key: 'g1', kind: 'end', state: 'unchecked', guess: 'near V-9' },
        { key: 'g2', kind: 'link', state: 'unchecked', guess: 'on S2' },
      ]);
      expect(imageCheckSummary(out)).toMatchObject({ guesses: 2, unchecked: 2 });
      // Normalizing again changes nothing.
      expect(honestImageChecks(out, holds)).toBe(out);
    }
  });

  it('dropping marks never drops the count: the provenance lists them', () => {
    const d = traced();
    const dropped = {
      ...d,
      offpage: (d.offpage as Record<string, unknown>[]).map(({ check: _c, ...o }) => o),
    };
    const out = honestImageChecks(dropped, holds);
    expect(out).toBe(dropped);
    expect(imageCheckSummary(out)).toMatchObject({ guesses: 3, unchecked: 3, checked: 0 });
  });

  it("a set: the set's provenance vouches for every page; one on a page is dropped", () => {
    const page = traced();
    delete page.provenance;
    const set = {
      set: true,
      title: 'Set',
      pages: [
        { id: 'p1', title: 'One', data: page },
        { id: 'p2', title: 'Two', data: { ...page, provenance: provenance(['g1', 'g2']) } },
      ],
      provenance: provenance(['g1', 'g2', 'g3']),
    };
    const out = honestImageChecks(set, holds) as typeof set;
    expect(out.pages[0]).toBe(set.pages[0]);
    expect((out.pages[1]!.data as Record<string, unknown>).provenance).toBeUndefined();
    expect(marksOf(out.pages[1]!.data)[1]).toEqual(signed(yes));
    expect(imageCheckSummary(out)).toMatchObject({ guesses: 3, checked: 1, unchecked: 2 });
  });

  it('the canvas: a genuine one byte for byte, a forged one honest and recounted', () => {
    const genuine = buildCanvas({ template: 'pid', data: traced(), mode: 'import' });
    const once = withHonestImageChecks(genuine, holds);
    // The count is added once; then it is byte for byte.
    expect(withHonestImageChecks(once, holds)).toBe(once);
    expect(readCanvasData(once).checks).toMatchObject({ guesses: 3, checked: 1 });
    const forged = buildCanvas({
      template: 'pid',
      data: { ...traced([signed(fresh), { ...yes }]), checks: { guesses: 1 } },
      mode: 'import',
    });
    const out = readCanvasData(withHonestImageChecks(forged, holds));
    expect(out.checks).toEqual({
      guesses: 3,
      unchecked: 3,
      checked: 0,
      unsure: 0,
      contradicted: 0,
      corrected: 0,
    });
  });
});

describe('the contract the view reads', () => {
  it('a mark takes `sig`; a drawing and a set take `provenance`; old unsigned marks still parse', () => {
    expect(validate('pid', traced()).ok).toBe(true);
    const old = traced([fresh, { ...yes }]);
    delete old.provenance;
    expect(validate('pid', old).ok).toBe(true);
    const bad = { ...traced(), provenance: { id: 'x', keys: [], sig: 'y' } };
    const r = validate('pid', bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/provenance: must be \{ id, keys, sig \}/);
  });

  it("a corrected mark without `alt` parses (a corrected link's far end)", () => {
    const far = { key: 'g2', kind: 'link', state: 'corrected', answer: 'no' };
    expect(validate('pid', traced([fresh, far])).ok).toBe(true);
  });
});

describe('the data block a save reads is the one the runtime reads', () => {
  it('counts every element carrying the id, and the blocks as written', () => {
    const one = buildCanvas({ template: 'pid', data: traced(), mode: 'import' });
    expect(dataBlockCount(one)).toEqual({ any: 1, written: 1 });
    expect(dataBlockCount('<p>no diagram</p>')).toEqual({ any: 0, written: 0 });
    const swapped = one.replace(
      '<script type="application/json" id="diagram-data">',
      '<script id="diagram-data" type="application/json">',
    );
    expect(dataBlockCount(swapped)).toEqual({ any: 1, written: 0 });
    const second = one.replace('<main', "<div ID='diagram-data'>{}</div><main");
    expect(dataBlockCount(second)).toEqual({ any: 2, written: 1 });
  });
});
