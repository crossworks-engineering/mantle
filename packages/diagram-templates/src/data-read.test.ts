/**
 * The runtime's read of the data block (data-read.ts) against a small
 * stand-in document: marks are trusted only from a block where buildCanvas
 * puts it, and data from anywhere else draws every mark unchecked, with no
 * evidence and the GUESS words (render, mount's own path, and the `render`
 * a mini app or an author's script calls). The real parser is probed in a
 * browser separately (svg/math entities, a script before the runtime).
 * Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { readDataBlock, unvouched } from './data-read.ts';
import { render } from './browser.ts';
import { estimateMeasurer, imageCheckSummary, render as renderIndex } from './index.ts';

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

type Spec = { tag: string; ns?: string; id?: string; type?: string; kids?: Spec[]; text?: string };
type FakeEl = {
  namespaceURI: string;
  localName: string;
  id: string;
  textContent: string;
  parentElement: FakeEl | null;
  children: FakeEl[];
  childNodes: FakeEl[];
  getAttribute: (n: string) => string | null;
};

function el(spec: Spec, parent: FakeEl | null, all: FakeEl[]): FakeEl {
  const e: FakeEl = {
    namespaceURI: spec.ns ?? XHTML,
    localName: spec.tag,
    id: spec.id ?? '',
    textContent: spec.text ?? '',
    parentElement: parent,
    children: [],
    childNodes: [],
    getAttribute: (n) =>
      n === 'type' ? (spec.type ?? null) : n === 'id' ? (spec.id ?? null) : null,
  };
  all.push(e);
  for (const k of spec.kids ?? []) {
    const c = el(k, e, all);
    e.children.push(c);
    e.childNodes.push(c);
  }
  return e;
}

/** A document of `head` and `body` children. */
function doc(head: Spec[], body: Spec[]): Document {
  const all: FakeEl[] = [];
  const root = el(
    {
      tag: 'html',
      kids: [
        { tag: 'head', kids: head },
        { tag: 'body', kids: body },
      ],
    },
    null,
    all,
  );
  const [h, b] = root.children;
  return {
    head: h,
    body: b,
    getElementById: (id: string) => all.find((e) => e.id === id) ?? null,
    getElementsByTagName: (t: string) => all.filter((e) => e.localName === t),
    getElementsByTagNameNS: (ns: string) => all.filter((e) => e.namespaceURI === ns),
  } as unknown as Document;
}

const DATA = (text = '{}'): Spec => ({
  tag: 'script',
  type: 'application/json',
  id: 'diagram-data',
  text,
});
const CANONICAL_BODY = (data: Spec = DATA()): Spec[] => [
  { tag: 'main', id: 'diagram' },
  { tag: 'div', id: 'diagram-errors' },
  data,
  { tag: 'script', type: 'module' },
];
/** The Present frame's prelude in the head, once its classic script ran
 *  (it removes itself). */
const PRELUDE: Spec[] = [
  { tag: 'meta' },
  { tag: 'script', type: 'importmap' },
  { tag: 'style' },
  { tag: 'title' },
];

describe('the data block is trusted only where buildCanvas puts it', () => {
  it('the canonical document, in the frame or alone', () => {
    expect(readDataBlock(doc(PRELUDE, CANONICAL_BODY(DATA('{"a":1}'))))).toEqual({
      text: '{"a":1}',
      canonical: true,
    });
    expect(readDataBlock(doc([{ tag: 'title' }], CANONICAL_BODY())).canonical).toBe(true);
  });

  it('anything else is not: an author script, foreign content, another place', () => {
    const cases: [string, Document][] = [
      [
        'a script before the runtime in the body',
        doc(PRELUDE, [
          { tag: 'main', id: 'diagram' },
          { tag: 'div', id: 'diagram-errors' },
          { tag: 'script' },
          DATA(),
          { tag: 'script', type: 'module' },
        ]),
      ],
      ['a classic script in the head', doc([...PRELUDE, { tag: 'script' }], CANONICAL_BODY())],
      [
        'the block inside <svg>',
        doc(PRELUDE, [
          { tag: 'main', id: 'diagram' },
          { tag: 'div', id: 'diagram-errors' },
          { tag: 'svg', ns: SVG, kids: [{ ...DATA(), ns: SVG }] },
          { tag: 'script', type: 'module' },
        ]),
      ],
      ['an SVG element anywhere', doc([...PRELUDE, { tag: 'svg', ns: SVG }], CANONICAL_BODY())],
      [
        'markup in the drawing',
        doc(PRELUDE, [
          { tag: 'main', id: 'diagram', kids: [{ tag: 'b' }] },
          { tag: 'div', id: 'diagram-errors' },
          DATA(),
          { tag: 'script', type: 'module' },
        ]),
      ],
      [
        'the block as a div',
        doc(PRELUDE, CANONICAL_BODY({ tag: 'div', id: 'diagram-data', text: '{}' })),
      ],
      [
        'the block in the head',
        doc(
          [...PRELUDE, DATA()],
          [
            { tag: 'main', id: 'diagram' },
            { tag: 'div', id: 'diagram-errors' },
            { tag: 'p' },
            { tag: 'script', type: 'module' },
          ],
        ),
      ],
    ];
    for (const [why, d] of cases) expect(readDataBlock(d).canonical, why).toBe(false);
    expect(readDataBlock(doc(PRELUDE, []))).toEqual({ text: null, canonical: false });
  });
});

describe('data no save vouched for draws every mark unchecked', () => {
  const yes = {
    key: 'g2',
    kind: 'link',
    state: 'checked',
    guess: 'on S2',
    question: 'Does it go on S2?',
    answer: 'yes',
    crops: ['crop1'],
    sig: 'a'.repeat(64),
  };
  const forged = {
    template: 'pid',
    title: 'Forged',
    equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
    offpage: [{ id: 'OPC-2', direction: 'out', sheet: 'S2', text: 'TO S2', check: yes }],
    lines: [{ from: 'V-101', to: 'OPC-2' }],
    provenance: { id: '0123456789abcdef', keys: ['g2'], sig: 'b'.repeat(64) },
    checks: { guesses: 1, unchecked: 0, checked: 1, unsure: 0, contradicted: 0, corrected: 0 },
  };

  it('unvouched: no evidence, no provenance, the count its own', () => {
    const out = unvouched(forged) as typeof forged;
    expect(out.offpage[0]!.check).toEqual({
      key: 'g2',
      kind: 'link',
      state: 'unchecked',
      guess: 'on S2',
    });
    expect(out.provenance).toBeUndefined();
    expect(imageCheckSummary(out)).toMatchObject({ guesses: 1, unchecked: 1, checked: 0 });
    expect(out.checks).toMatchObject({ checked: 0, unchecked: 1 });
  });

  it("the browser's render, as a mini app or an author's script calls it, never says CHECKED BY IMAGE", () => {
    const r = render('pid', forged, estimateMeasurer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.svg).not.toContain('CHECKED BY IMAGE');
    // Drawn exactly as the same drawing with every mark unchecked.
    const plain = renderIndex('pid', unvouched(forged), estimateMeasurer);
    expect(plain.ok && plain.svg).toBe(r.svg);
  });
});
