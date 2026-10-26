/**
 * Sealed image check marks (templates/pid/check.ts honestImageChecks,
 * canvas.ts withHonestImageChecks): a save keeps a mark only as
 * circuit_trace sealed it, under a sealed provenance, on the element it
 * was sealed on; any other claim is made unchecked with its evidence
 * stripped, a drawing without a provenance shows no check at all, and a
 * guess whose mark was dropped still counts. The trust words are drawn
 * from the marks and never kept in a label. The data block a save reads
 * is the one a browser reads. The seal check is a stand-in HMAC under a
 * test key (the real one is the content layer's). Synthetic data only.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCanvas,
  dataBlockCount,
  honestImageChecks,
  imageCheckSummary,
  lineNoteSuffix,
  MARK_WORDS,
  markSuffix,
  provenanceSealBody,
  readCanvasData,
  signImageChecks,
  validate,
  withHonestImageChecks,
  withoutMarkWords,
} from './index.ts';

const seal = (body: string, key = 'test-key') =>
  createHmac('sha256', key).update(body).digest('hex');
const holds = (body: string, sig: string) => seal(body) === sig;

const PROV = '0123456789abcdef';
type Mark = Record<string, unknown>;
type Drawing = Record<string, unknown>;
const provenance = (keys: string[], id = PROV) => ({
  id,
  keys,
  sig: seal(provenanceSealBody({ id, keys })),
});
/** The drawing with every mark sealed where it sits (circuit_trace's one
 *  path), under `id` and `key`. */
const sign = (d: Drawing, id = PROV, key?: string): Drawing =>
  signImageChecks(d, id, (body) => seal(body, key));

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

/** One traced drawing, unsealed: g1 unchecked, g2 checked, the
 *  provenance listing g1 to g3. */
function drawn(marks: Mark[] = [fresh, yes], keys = ['g1', 'g2', 'g3']): Drawing {
  return {
    title: 'Traced',
    equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
    offpage: [
      { id: 'OPC-1', direction: 'in', sheet: 'S1', text: 'NEAR V-9', check: marks[0] },
      { id: 'OPC-2', direction: 'out', sheet: 'S2', text: 'TO S2', check: marks[1] },
    ],
    lines: [
      { from: 'OPC-1', to: 'V-101' },
      { from: 'V-101', to: 'OPC-2' },
    ],
    provenance: provenance(keys),
  };
}
/** The same, sealed: what circuit_trace hands over. */
const traced = (marks?: Mark[], keys?: string[]) => sign(drawn(marks, keys));
const marksOf = (d: unknown) =>
  (d as { offpage: { check: Record<string, unknown> }[] }).offpage.map((o) => o.check);
const withMark = (d: Drawing, i: number, check: unknown): Drawing => ({
  ...d,
  offpage: (d.offpage as Drawing[]).map((o, j) => (j === i ? { ...o, check } : o)),
});
const unchecked = (m: Mark) => ({
  key: m.key,
  kind: m.kind,
  state: 'unchecked',
  ...(m.guess !== undefined ? { guess: m.guess } : {}),
});

describe('a save keeps only sealed marks', () => {
  it('a genuine traced drawing comes back as the same object, and validates', () => {
    const d = traced();
    expect(honestImageChecks(d, holds)).toBe(d);
    expect(validate('pid', d).ok).toBe(true);
    // g3 is listed and has no mark: it still counts, unchecked.
    expect(imageCheckSummary(d)).toMatchObject({ guesses: 3, unchecked: 2, checked: 1 });
  });

  it('a mark changed by hand, from another trace or key, or unsealed is made unchecked', () => {
    const d = traced();
    const sealed = marksOf(d)[1]!;
    const raised = marksOf(sign(drawn([fresh, { ...yes, state: 'unsure', answer: 'unsure' }])))[1]!;
    for (const bad of <Mark[]>[
      { ...sealed, reason: 'typed' },
      { ...raised, state: 'checked', answer: 'yes' },
      marksOf(sign(drawn(), 'fedcba9876543210'))[1]!,
      marksOf(sign(drawn(), PROV, 'another-key'))[1]!,
      { ...yes },
    ]) {
      const out = honestImageChecks(withMark(d, 1, bad), holds);
      expect(marksOf(out)[1]).toEqual(unchecked(yes));
      expect(marksOf(out)[0]).toEqual(marksOf(d)[0]);
    }
  });

  it('a sealed mark past the provenance key cap still holds: the seal covers its key', () => {
    const d = traced(undefined, ['g1']);
    expect(honestImageChecks(d, holds)).toBe(d);
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
    const page = drawn();
    delete page.provenance;
    const set = sign({
      set: true,
      title: 'Set',
      pages: [
        { id: 'p1', title: 'One', data: page },
        { id: 'p2', title: 'Two', data: { ...page, provenance: provenance(['g1', 'g2']) } },
      ],
      provenance: provenance(['g1', 'g2', 'g3']),
    }) as { pages: { data: Drawing }[] };
    const out = honestImageChecks(set, holds) as typeof set;
    expect(out.pages[0]).toBe(set.pages[0]);
    expect((out.pages[1]!.data as Record<string, unknown>).provenance).toBeUndefined();
    expect(marksOf(out.pages[1]!.data)[1]).toEqual(marksOf(set.pages[1]!.data)[1]);
    expect(marksOf(out.pages[1]!.data)[1]).toMatchObject({ state: 'checked' });
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
      data: { ...withMark(traced(), 1, { ...yes }), checks: { guesses: 1 } },
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

describe('a sealed mark holds only on the element it was sealed on (MED-4)', () => {
  /** A drawing with a line's inferred-join marks and an inline valve's. */
  function lined(): Drawing {
    return {
      ...drawn(),
      lines: [
        {
          id: 'L1',
          from: 'OPC-1',
          to: 'V-101',
          note: 'INFERRED JOIN',
          checks: [{ ...yes, key: 'j1', kind: 'join', guess: 'a join' }],
          inline: [
            { type: 'gate' },
            {
              type: 'globe',
              check: { ...yes, key: 'v1', kind: 'valve', guess: 'a globe valve' },
            },
          ],
        },
        { id: 'L2', from: 'V-101', to: 'OPC-2', note: 'INFERRED JOIN', inline: [{ type: 'gate' }] },
      ],
      provenance: provenance(['g1', 'g2', 'j1', 'v1']),
    };
  }
  type Line = { checks?: Mark[]; inline?: Drawing[]; note?: string; to?: string };
  const linesOf = (d: unknown) => (d as { lines: Line[] }).lines;

  it('a sealed drawing holds as drawn', () => {
    const d = sign(lined());
    expect(honestImageChecks(d, holds)).toBe(d);
  });

  it('a connector mark copied onto another connector is unchecked there', () => {
    const d = traced();
    const copied = withMark(d, 0, { ...marksOf(d)[1]!, key: 'g2' });
    const out = honestImageChecks(copied, holds);
    expect(marksOf(out)[0]).toEqual(unchecked(yes));
    expect(marksOf(out)[1]).toEqual(marksOf(d)[1]);
  });

  it("a connector's text or sheet changed under its mark unchecks it", () => {
    const d = traced();
    for (const change of [{ text: 'TO S9' }, { sheet: 'S9' }]) {
      const edited = {
        ...d,
        offpage: (d.offpage as Drawing[]).map((o, i) => (i === 1 ? { ...o, ...change } : o)),
      };
      expect(marksOf(honestImageChecks(edited, holds))[1]).toEqual(unchecked(yes));
    }
  });

  it("a line's join marks and an inline valve's copied onto another line are unchecked", () => {
    const d = sign(lined());
    const [l1, l2] = linesOf(d);
    const moved = {
      ...d,
      lines: [
        l1,
        {
          ...l2,
          checks: l1!.checks,
          inline: [{ type: 'globe', check: l1!.inline![1]!.check }],
        },
      ],
    };
    const out = linesOf(honestImageChecks(moved, holds));
    expect(out[0]).toBe(l1);
    expect(out[1]!.checks![0]).toMatchObject({ key: 'j1', state: 'unchecked' });
    expect(out[1]!.checks![0]!.sig).toBeUndefined();
    expect(out[1]!.inline![0]!.check).toMatchObject({ key: 'v1', state: 'unchecked' });
  });

  it("a line's note or end, or a valve's type, changed under the marks unchecks them", () => {
    const d = sign(lined());
    const l1 = linesOf(d)[0]!;
    for (const changed of [
      { ...l1, note: 'ALL GOOD' },
      { ...l1, to: 'OPC-2' },
      { ...l1, inline: [l1.inline![0], { ...l1.inline![1], type: 'ball' }] },
    ]) {
      const out = linesOf(honestImageChecks({ ...d, lines: [changed, linesOf(d)[1]] }, holds))[0]!;
      const states = [
        ...(out.checks ?? []).map((c) => c.state),
        (out.inline![1]!.check as Mark).state,
      ];
      expect(states).toContain('unchecked');
      if (changed.note !== l1.note || changed.to !== l1.to) {
        expect(states).toEqual(['unchecked', 'unchecked']);
      } else {
        // Only the valve whose type changed.
        expect(states).toEqual(['checked', 'unchecked']);
      }
    }
  });
});

describe('the trust words: drawn from the mark, never typed into a label (MED-3)', () => {
  it('each state has its words, from the one list', () => {
    expect(markSuffix('unchecked')).toBe(` (${MARK_WORDS.guess})`);
    expect(markSuffix('unsure')).toBe(' (GUESS)');
    expect(markSuffix('checked')).toBe(' (CHECKED BY IMAGE)');
    expect(markSuffix('contradicted')).toBe(' (GUESS, IMAGE: NO)');
    expect(markSuffix('corrected')).toBe(' (FROM IMAGE)');
  });

  it("a line's words come from its join marks, else its answered valves", () => {
    const j = (state: string) => ({ key: 'k', kind: 'join', state });
    const v = (state: string) => ({ type: 'globe', check: { key: 'v', kind: 'valve', state } });
    expect(lineNoteSuffix({ checks: [j('checked'), j('checked')] })).toBe(' (CHECKED BY IMAGE)');
    expect(lineNoteSuffix({ checks: [j('checked'), j('unchecked')] })).toBe(' (GUESS)');
    expect(lineNoteSuffix({ checks: [j('checked'), j('contradicted')] })).toBe(
      ' (GUESS, IMAGE: NO)',
    );
    expect(lineNoteSuffix({ checks: [j('contradicted'), j('unchecked'), j('contradicted')] })).toBe(
      ' (GUESS; IMAGE: 2 NO)',
    );
    expect(lineNoteSuffix({ inline: [v('checked'), v('corrected')] })).toBe(' (FROM IMAGE)');
    expect(lineNoteSuffix({ inline: [v('corrected'), v('contradicted')] })).toBe(
      ' (GUESS, IMAGE: NO)',
    );
    expect(lineNoteSuffix({ inline: [v('unchecked')] })).toBe('');
    expect(lineNoteSuffix({ note: 'X' })).toBe('');
  });

  it('a save strips typed claim words from every label, and GUESS where a mark draws it', () => {
    const d = traced();
    const typed: Drawing = {
      ...d,
      title: 'Traced (checked by image)',
      equipment: [
        { id: 'V-101 (FROM IMAGE)', type: 'vertical-vessel', service: 'CHECKED-BY-IMAGE' },
      ],
      offpage: (d.offpage as Drawing[]).map((o) => ({ ...o, text: `${String(o.text)} (GUESS)` })),
      lines: [
        { from: 'OPC-1', to: 'V-101 (FROM IMAGE)', note: 'PUMP (GUESS, IMAGE: NO)' },
        { from: 'V-101 (FROM IMAGE)', to: 'OPC-2', note: '3 JOINS (GUESS; IMAGE: 1 NO)' },
      ],
      description: 'CHECKED BY IMAGE: a vision model saw it.',
    };
    const out = withoutMarkWords(typed) as Drawing;
    expect(out.title).toBe('Traced');
    expect(out.equipment).toEqual([{ id: 'V-101', type: 'vertical-vessel', service: '' }]);
    // A connector with a mark: its GUESS is the view's.
    expect((out.offpage as Drawing[]).map((o) => o.text)).toEqual(['NEAR V-9', 'TO S2']);
    // A line with no mark keeps GUESS (it claims no check), never IMAGE: NO;
    // references still name their element.
    expect(out.lines).toEqual([
      { from: 'OPC-1', to: 'V-101', note: 'PUMP (GUESS)' },
      { from: 'V-101', to: 'OPC-2', note: '3 JOINS (GUESS)' },
    ]);
    // The prose description is not a label.
    expect(out.description).toBe(typed.description);
    // A clean drawing is the same object.
    expect(withoutMarkWords(d)).toBe(d);
    // The save strips first, then checks the seals: the marks still hold.
    const saved = honestImageChecks(typed, holds);
    expect(marksOf(saved)).toEqual(marksOf(d));
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
    // The committed canvas, its runtime inline: nothing in that code reads
    // as a second block.
    const inline = readFileSync(join(__dirname, '../templates/pid.canvas.html'), 'utf8');
    expect(dataBlockCount(inline)).toEqual({ any: 1, written: 1 });
    expect(dataBlockCount('<p>no diagram</p>')).toEqual({ any: 0, written: 0 });
    const swapped = one.replace(
      '<script type="application/json" id="diagram-data">',
      '<script id="diagram-data" type="application/json">',
    );
    expect(dataBlockCount(swapped)).toEqual({ any: 1, written: 0 });
    const second = one.replace('<main', "<div ID='diagram-data'>{}</div><main");
    expect(dataBlockCount(second)).toEqual({ any: 2, written: 1 });
  });

  it('an id with character references counts as the browser decodes it (MED-2)', () => {
    const one = buildCanvas({ template: 'pid', data: traced(), mode: 'import' });
    for (const forged of [
      '<div id="diagram&#45;data">{}</div>',
      '<div id="diagram&#x2d;data">{}</div>',
      '<div id="diagram&#45data">{}</div>',
      '<div id=diagram&#X2D;data>{}</div>',
      '<div title="a" ID = "&#100;iagram-data">{}</div>',
      '<div/id="diagram-data">{}</div>',
      '<div id="diagram&hyphen;data">{}</div>',
    ]) {
      const html = one.replace('<main', `${forged}<main`);
      expect(dataBlockCount(html), forged).toEqual({ any: 2, written: 1 });
    }
  });

  it('only attributes of tags count: the id in prose or in a value is not an element', () => {
    const one = buildCanvas({ template: 'pid', data: traced(), mode: 'import' });
    for (const text of [
      "<p>write id='diagram-data' on the block</p>",
      '<p title="id=diagram-data">x</p>',
      '<p data-x="diagram-data">x</p>',
    ]) {
      expect(dataBlockCount(one.replace('<main', `${text}<main`)), text).toEqual({
        any: 1,
        written: 1,
      });
    }
  });

  it('a block the browser ends or extends where this package does not is not read as written (MED-1)', () => {
    const one = buildCanvas({ template: 'pid', data: traced(), mode: 'import' });
    const open = '<script type="application/json" id="diagram-data">';
    const upper = one.replace(
      /(<script type="application\/json" id="diagram-data">[^<]*)<\/script>/,
      '$1</SCRIPT>',
    );
    expect(upper).not.toBe(one);
    expect(dataBlockCount(upper).written).toBe(0);
    expect(() => readCanvasData(upper)).toThrow(/no <script/);
    const escaped = one.replace(open, `${open}<!--<script>`);
    expect(dataBlockCount(escaped).written).toBe(0);
  });
});
