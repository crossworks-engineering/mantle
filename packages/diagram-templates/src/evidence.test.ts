/**
 * The image check's evidence: a `check` on a line, a valve, a connector or
 * equipment draws a `data-check` key on that element (and in style 2 a small
 * "i" badge), the render returns the evidence under that key, and the live
 * canvas opens it on click: the crop from the canvas's assets block, the
 * question, the answer, the model. Without check fields nothing changes. A
 * drawing-wide `checks.unchecked` prints "N GUESSES NOT CHECKED BY IMAGE".
 * All tags, ids and answers are made up.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  assetsBlockCount,
  buildCanvas,
  checkCropIds,
  checkStaticSvg,
  estimateMeasurer,
  parseCanvasAssets,
  readCanvasAssets,
  render,
  replaceCanvasAssets,
  safeCropUrl,
  validate,
  withSealedCanvasAssets,
  type CanvasCrop,
} from './index.ts';
import { mount } from './browser.ts';
import { ROLE_COLOURS } from './runtime/style.ts';

const CROP_ID = '11111111-2222-4333-8444-555555555555';
// A 1x1 PNG.
const CROP =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** A made-up seal: the content layer checks real ones (drawing-seal.ts). */
const SIG = 'a'.repeat(64);
const SEALED: CanvasCrop = { src: CROP, sig: SIG };

const base = (extra: Record<string, unknown> = {}) => ({
  title: 'Evidence check',
  description: 'A made-up line with a guessed valve and a guessed end.',
  equipment: [
    { id: 'E-1', type: 'shell-tube-exchanger' },
    { id: 'V-2', type: 'vertical-vessel' },
  ],
  offpage: [{ id: 'OPC-1', direction: 'out', sheet: 'V-9', text: 'NEAR V-9 (GUESS)' }],
  lines: [
    {
      id: 'L1',
      number: '2"-P-0001-A1',
      from: 'E-1',
      to: 'V-2',
      note: 'VALVE TYPE (GUESS, IMAGE: NO)',
      inline: [{ type: 'orifice' }, { type: 'gate' }],
    },
    { id: 'L2', from: 'V-2', to: 'OPC-1', weight: 'secondary' },
  ],
  ...extra,
});

const withChecks = (style?: number) => {
  const d = base(style ? { style } : {}) as ReturnType<typeof base> & Record<string, unknown>;
  const lines = d.lines as Record<string, any>[];
  lines[0]!.inline[0].check = {
    key: 'v1',
    kind: 'valve',
    state: 'corrected',
    guess: 'gate valve, read from a block name',
    answer: 'no',
    alt: 'orifice',
    question: 'Is the symbol at the green ring a gate valve?',
    reason: 'Two parallel bars across the pipe: a flow element.',
    model: 'example/vision-1',
    crops: [CROP_ID],
  };
  // Three inferred joins on one line: one unanswered, one unsure, one yes.
  lines[0]!.checks = [
    { key: 'j1', kind: 'join', state: 'unchecked' },
    { key: 'j2', kind: 'join', state: 'unsure', answer: 'unsure', question: 'One pipe?' },
    { key: 'j3', kind: 'join', state: 'checked', answer: 'yes', question: 'One pipe?' },
  ];
  (d.offpage as Record<string, any>[])[0]!.check = {
    key: 'e1',
    kind: 'end',
    state: 'unchecked',
  };
  // A stored count the note never reads (it counts the marks: 2 unchecked).
  return {
    ...d,
    checks: { guesses: 9, unchecked: 7, checked: 0, unsure: 0, contradicted: 0, corrected: 2 },
  };
};

describe('check fields in the data', () => {
  it('a drawing without them draws exactly as before (no keys, no badge, no note)', () => {
    const r = render('pid', base(), estimateMeasurer);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.svg).not.toContain('data-check');
    expect(r.checks).toBeUndefined();
    expect(r.svg).not.toContain('NOT CHECKED BY IMAGE');
  });

  it('are checked: a bad state, answer or crop id is an error with its path', () => {
    const bad = base() as Record<string, any>;
    bad.lines[0].inline[0].check = { key: 'k', kind: 'valve', state: 'guess', answer: 'perhaps' };
    bad.lines[0].checks = [{ key: 'j', kind: 'join', state: 'checked', crops: ['../x'] }];
    bad.checks = { unchecked: -1 };
    const r = validate('pid', bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join('\n');
    expect(all).toMatch(/lines\[0\]\.inline\[0\]\.check\.state/);
    expect(all).toMatch(/lines\[0\]\.inline\[0\]\.check\.answer/);
    expect(all).toMatch(/lines\[0\]\.checks\[0\]\.crops/);
    expect(all).toMatch(/checks\.unchecked/);
  });

  it.each([1, 2])(
    'style %s: keys on the checked elements, the evidence returned, the unchecked note drawn',
    (style) => {
      const r = render('pid', withChecks(style), estimateMeasurer);
      if (!r.ok) throw new Error(r.errors.join());
      expect(checkStaticSvg(r.svg)).toEqual([]);
      const keys = r.checks!.map((c) => c.key).sort();
      expect(keys).toEqual(['inline:L1:0', 'line:L1', 'offpage:OPC-1']);
      for (const k of keys) expect(r.svg).toContain(`data-check="${k}"`);
      const valve = r.checks!.find((c) => c.key === 'inline:L1:0')!;
      expect(valve.checks[0]).toMatchObject({
        state: 'corrected',
        alt: 'orifice',
        crops: [CROP_ID],
      });
      expect(valve.what).toMatch(/orifice item on line 2"-P-0001-A1/);
      expect(r.checks!.find((c) => c.key === 'line:L1')!.checks).toHaveLength(3);
      // Counted from the marks (j1 and e1), not the stored 7.
      expect(r.svg).toContain('>2 GUESSES NOT CHECKED BY IMAGE<');
      // Style 2 adds the badges and the state colours; style 1 neither.
      const badges = (r.svg.match(/data-part="check-badge"/g) ?? []).length;
      if (style === 2) {
        // The unanswered end (no answer, no question, no crop) has none.
        expect(badges).toBe(2);
        expect(r.svg).toContain(`stroke="${ROLE_COLOURS.corrected}"`);
        expect(r.svg).toContain(`fill="${ROLE_COLOURS.guess}"`);
      } else expect(badges).toBe(0);
    },
  );

  it('a set keeps each page its own evidence and every page the note', () => {
    const page = withChecks(2);
    const { checks: _stored, ...data } = page;
    const set = {
      title: 'Evidence set',
      description: 'Two made-up pages.',
      style: 2,
      pages: [
        { id: 'a', title: 'A', data },
        { id: 'b', title: 'B', data: base() },
      ],
    };
    const r = render('pid', set, estimateMeasurer);
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.pages![0]!.checks!.length).toBe(3);
    expect(r.pages![1]!.checks).toBeUndefined();
    // Each page says its own marks' count.
    expect(r.pages![0]!.svg).toContain('>2 GUESSES NOT CHECKED BY IMAGE<');
    expect(r.pages![1]!.svg).not.toContain('NOT CHECKED BY IMAGE');
  });
});

describe('the canvas carries the crops', () => {
  it('in an assets block, read back and replaced; never in the data', () => {
    const html = buildCanvas({
      template: 'pid',
      data: withChecks(2),
      mode: 'import',
      assets: { crops: { [CROP_ID]: SEALED } },
    });
    expect(readCanvasAssets(html)).toEqual({ crops: { [CROP_ID]: SEALED } });
    expect(html.indexOf('id="diagram-assets"')).toBeGreaterThan(html.indexOf('id="diagram-data"'));
    const without = replaceCanvasAssets(html, null);
    expect(without).not.toContain('diagram-assets');
    expect(replaceCanvasAssets(without, { crops: { [CROP_ID]: SEALED } })).toBe(html);
    // Every block goes, not only the first.
    const twice = html.replace(
      '</body>',
      `${html.match(/<script type="application\/json" id="diagram-assets">[^<]*<\/script>/)![0]}\n</body>`,
    );
    expect(assetsBlockCount(twice)).toEqual({ any: 2, written: 2 });
    expect(replaceCanvasAssets(twice, null)).not.toContain('diagram-assets');
    // A value that could close the script is escaped.
    const odd = buildCanvas({
      template: 'pid',
      data: base(),
      mode: 'import',
      assets: { crops: { [CROP_ID]: { src: '</script><b>', sig: SIG } } },
    });
    expect(odd).not.toContain('</script><b>');
  });

  it('shows only a base64 PNG, JPEG or WebP data URL', () => {
    expect(safeCropUrl(CROP)).toBe(CROP);
    expect(safeCropUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeCropUrl('https://example.invalid/a.png')).toBeNull();
    expect(safeCropUrl('data:image/png;base64,AAAA"onerror="x')).toBeNull();
    expect(safeCropUrl(`data:image/png;base64,${'A'.repeat(700_000)}`)).toBeNull();
  });

  it('one reader: a file id key, a picture the view may show, a seal', () => {
    const text = JSON.stringify({
      crops: {
        [CROP_ID.toUpperCase()]: SEALED,
        'not-an-id': SEALED,
        '22222222-2222-4333-8444-555555555555': {
          src: 'data:image/svg+xml;base64,PHN2Zz4=',
          sig: SIG,
        },
        '33333333-2222-4333-8444-555555555555': { src: CROP },
        '44444444-2222-4333-8444-555555555555': CROP,
      },
    });
    expect(parseCanvasAssets(text)).toEqual({ crops: { [CROP_ID]: SEALED } });
    expect(parseCanvasAssets('not json')).toEqual({ crops: {} });
    expect(parseCanvasAssets(null)).toEqual({ crops: {} });
  });

  it('a save keeps a crop only when its seal holds and a mark still names it', () => {
    const OTHER = '99999999-2222-4333-8444-555555555555';
    const html = buildCanvas({
      template: 'pid',
      data: withChecks(2),
      mode: 'import',
      assets: { crops: { [CROP_ID]: SEALED, [OTHER]: SEALED } },
    });
    expect(checkCropIds(withChecks(2))).toEqual([CROP_ID]);
    const seen: string[] = [];
    const holds = (id: string, src: string, sig: string) => {
      seen.push(id);
      return src === CROP && sig === SIG;
    };
    // OTHER is named by no mark: gone, its seal never asked.
    const kept = withSealedCanvasAssets(html, holds);
    expect(readCanvasAssets(kept)).toEqual({ crops: { [CROP_ID]: SEALED } });
    expect(seen).toEqual([CROP_ID]);
    // Already honest: byte for byte.
    expect(withSealedCanvasAssets(kept, holds)).toBe(kept);
    // A swapped picture under the same seal: dropped.
    const swapped = kept.replace(CROP, `${CROP.slice(0, -4)}AAA=`);
    expect(readCanvasAssets(withSealedCanvasAssets(swapped, holds))).toEqual({ crops: {} });
    expect(withSealedCanvasAssets(swapped, holds)).not.toContain('diagram-assets');
    // A second block is folded into one.
    const block = kept.match(
      /<script type="application\/json" id="diagram-assets">[^<]*<\/script>/,
    )![0];
    const twice = kept.replace('</body>', `${block}\n</body>`);
    expect(assetsBlockCount(withSealedCanvasAssets(twice, holds))).toEqual({ any: 1, written: 1 });
    // A block written another way is counted, for the save to refuse.
    const sly = kept.replace('</body>', '<div id=diagram-assets></div></body>');
    expect(assetsBlockCount(sly)).toEqual({ any: 2, written: 1 });
  });
});

describe('the live canvas opens the evidence', () => {
  const open = async (crops: Record<string, CanvasCrop>, style?: number) => {
    const html = buildCanvas({
      template: 'pid',
      data: withChecks(style),
      mode: 'import',
      assets: { crops },
    }).replace(/<script type="module">[\s\S]*?<\/script>/, '');
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    const win = dom.window;
    (win.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (
      this: Element,
    ) {
      return { x: 0, y: 0, width: (this.textContent ?? '').length * 6, height: 10 } as DOMRect;
    };
    const g = globalThis as { window?: unknown };
    const had = g.window;
    g.window = win;
    try {
      const api = mount(win.document);
      await api.ready;
      return { doc: win.document, win };
    } finally {
      g.window = had;
    }
  };

  it('a click shows the crop, the question, the answer and the model; Escape closes', async () => {
    const { doc, win } = await open({ [CROP_ID]: SEALED });
    const valve = doc.querySelector('[data-check="inline:L1:0"]')!;
    expect(valve.getAttribute('role')).toBe('button');
    expect(valve.getAttribute('tabindex')).toBe('0');
    expect(valve.getAttribute('aria-label')).toMatch(/Image check of orifice item/);
    valve.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const dialog = doc.querySelector('[role="dialog"]')!;
    expect(dialog.closest('.diagram-evidence')!.hasAttribute('hidden')).toBe(false);
    expect(dialog.querySelector('img')!.getAttribute('src')).toBe(CROP);
    const text = dialog.textContent!;
    expect(text).toContain('From image (corrected, never certain)');
    expect(text).toContain('Is the symbol at the green ring a gate valve?');
    expect(text).toContain('No. The image says it is: orifice');
    expect(text).toContain('example/vision-1');
    doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.closest('.diagram-evidence')!.hasAttribute('hidden')).toBe(true);
  });

  it('Enter on a focused guess opens it; a crop not embedded is said, not fetched', async () => {
    const { doc, win } = await open({});
    const end = doc.querySelector('g[data-check="offpage:OPC-1"]')!;
    end.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const dialog = doc.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Guess, not checked by image');
    expect(dialog.textContent).toContain('No image has checked this guess yet.');
    expect(dialog.querySelector('img')).toBeNull();
    doc.querySelector<HTMLButtonElement>('.diagram-evidence button')!.click();
    const valve = doc.querySelector('[data-check="inline:L1:0"]')!;
    valve.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    expect(dialog.textContent).toContain('not embedded in this canvas');
    expect(dialog.querySelector('img')).toBeNull();
  });

  it('style 2: one tab stop per checked item, its badge', async () => {
    const { doc, win } = await open({ [CROP_ID]: SEALED }, 2);
    const parts = [...doc.querySelectorAll('[data-check="inline:L1:0"]')];
    const badge = parts.find((e) => e.getAttribute('data-part') === 'check-badge')!;
    expect(badge.getAttribute('tabindex')).toBe('0');
    expect(parts.filter((e) => e.getAttribute('tabindex') === '0')).toEqual([badge]);
    // The drawn item still opens it on a click.
    parts.find((e) => e !== badge)!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    expect(doc.querySelector('[role="dialog"] img')!.getAttribute('src')).toBe(CROP);
  });

  it('a bad crop in the assets block is never shown', async () => {
    const { doc, win } = await open({
      [CROP_ID]: { src: 'data:image/svg+xml;base64,PHN2Zz4=', sig: SIG },
    });
    doc
      .querySelector('[data-check="inline:L1:0"]')!
      .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    expect(doc.querySelector('[role="dialog"] img')).toBeNull();
  });
});
