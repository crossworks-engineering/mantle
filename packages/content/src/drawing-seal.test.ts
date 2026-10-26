/**
 * The drawing check seal on the save side (drawing-seal.ts): a canvas's
 * image check marks hold under the brain's key as the Checks tab's rows
 * do, through a master key rotation (sealed under the staged key, accepted
 * under either, dropped with the old key); a canvas whose data block the
 * runtime could read in another form is refused; the purpose-labelled
 * helper never confuses one purpose's seal with another's. Test keys only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCanvas,
  provenanceSealBody,
  readCanvasData,
  signImageChecks,
} from '@mantle/diagram-templates';
import {
  drawingSeal,
  drawingSealHolds,
  honestCanvasSource,
  sealPayload,
  sealPayloadHolds,
} from './drawing-seal';

const OLD = 'drawing-seal-test-old';
const NEW = 'drawing-seal-test-new';
const PROV = '0123456789abcdef';
const mark = {
  key: 'g1',
  kind: 'link',
  state: 'checked',
  guess: 'on S2',
  answer: 'yes',
  crops: ['crop1'],
};

/** A traced drawing's canvas, sealed under whichever key is current now. */
function sealedCanvas(): string {
  const keys = ['g1'];
  const data = signImageChecks(
    {
      title: 'Traced',
      equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
      offpage: [{ id: 'OPC-1', direction: 'out', sheet: 'S2', text: 'TO S2', check: mark }],
      lines: [{ from: 'V-101', to: 'OPC-1' }],
      checks: { guesses: 1, unchecked: 0, checked: 1, unsure: 0, contradicted: 0, corrected: 0 },
      provenance: {
        id: PROV,
        keys,
        sig: drawingSeal(provenanceSealBody({ id: PROV, keys }, { title: 'Traced' })),
      },
    },
    PROV,
    drawingSeal,
  );
  return buildCanvas({ template: 'pid', mode: 'import', data });
}
const stateOf = (html: string) =>
  (readCanvasData(html) as { offpage: { check: { state: string } }[] }).offpage[0]!.check.state;

beforeEach(() => {
  vi.stubEnv('MANTLE_MASTER_KEY', OLD);
  vi.stubEnv('MANTLE_MASTER_KEY_NEXT', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a saved canvas under a master key rotation', () => {
  it('holds while the rotation is staged, and after it; the old key alone stops holding', () => {
    const before = sealedCanvas();
    expect(honestCanvasSource(before)).toBe(before);
    vi.stubEnv('MANTLE_MASTER_KEY_NEXT', NEW);
    expect(honestCanvasSource(before)).toBe(before);
    const during = sealedCanvas();
    expect(during).not.toBe(before);
    expect(honestCanvasSource(during)).toBe(during);
    // Promoted: the new key is current, the old one dropped.
    vi.stubEnv('MANTLE_MASTER_KEY', NEW);
    vi.stubEnv('MANTLE_MASTER_KEY_NEXT', undefined);
    expect(honestCanvasSource(during)).toBe(during);
    const stale = honestCanvasSource(before);
    expect(stateOf(stale)).toBe('unchecked');
    expect(readCanvasData(stale).provenance).toBeUndefined();
  });

  it('no master key: nothing is sealed, nothing holds, every mark is unchecked', () => {
    const sealed = sealedCanvas();
    vi.stubEnv('MANTLE_MASTER_KEY', undefined);
    expect(drawingSeal('x')).toBe('');
    expect(drawingSealHolds('x', 'a'.repeat(64))).toBe(false);
    expect(stateOf(honestCanvasSource(sealed))).toBe('unchecked');
  });
});

describe('the data block a save normalizes', () => {
  const REFUSED = /This diagram was not saved/;
  const OPEN = '<script type="application/json" id="diagram-data">';

  it('a canvas with no diagram data is left alone; a second or rewritten block is refused', () => {
    const page = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
    expect(honestCanvasSource(page)).toBe(page);
    const canvas = sealedCanvas();
    const swapped = canvas.replace(OPEN, '<script id="diagram-data" type="application/json">');
    expect(() => honestCanvasSource(swapped)).toThrow(REFUSED);
    const second = canvas.replace('<main', '<pre id=diagram-data>{}</pre><main');
    expect(() => honestCanvasSource(second)).toThrow(REFUSED);
  });

  it('the refusal is plain words for whoever saved, naming no tool', () => {
    const second = sealedCanvas().replace('<main', '<pre id=diagram-data>{}</pre><main');
    let said = '';
    try {
      honestCanvasSource(second);
    } catch (err) {
      said = (err as Error).message;
    }
    expect(said).toMatch(REFUSED);
    expect(said).not.toMatch(/present_|<script|_create|_update/);
  });

  it('one block the browser reads but this check cannot is refused, never saved as is (MED-1)', () => {
    const canvas = sealedCanvas();
    // Forged marks inside a block closed by </SCRIPT>: the browser ends the
    // block there and reads the JSON.
    const forged = canvas.replace('"state": "checked"', '"state": "checked", "reason": "typed"');
    expect(forged).not.toBe(canvas);
    const upper = forged.replace(/(id="diagram-data">[^<]*)<\/script>/, '$1</SCRIPT>');
    expect(upper).not.toBe(forged);
    expect(() => honestCanvasSource(upper)).toThrow(REFUSED);
    // A `<!--<script>` in the block keeps it open past its first close in
    // the browser (script data double-escaped).
    const escaped = forged.replace(OPEN, `${OPEN}<!--<script>`);
    expect(() => honestCanvasSource(escaped)).toThrow(REFUSED);
    // One block, written as this package writes it, that does not parse,
    // or parses as something other than an object.
    const broken = canvas.replace('"title": "Traced"', '"title": "Traced",,');
    expect(() => honestCanvasSource(broken)).toThrow(REFUSED);
    const list = canvas.replace(/(id="diagram-data">)[^<]*(<\/script>)/, '$1[1, 2]$2');
    expect(() => honestCanvasSource(list)).toThrow(REFUSED);
  });

  it('an id with character references is counted as the browser decodes it (MED-2)', () => {
    const canvas = sealedCanvas();
    const forged = canvas.replace('<main', '<pre id="diagram&#45;data">{}</pre><main');
    expect(() => honestCanvasSource(forged)).toThrow(REFUSED);
    // Prose that names the id is no element (a canvas of the author's own:
    // a diagram canvas holds no prose).
    const own = `<!doctype html><html><head><title>x</title></head><body><p>the block has id='diagram-data'</p><script type="application/json" id="diagram-data">\n{\n  "a": 1\n}\n</script></body></html>`;
    expect(honestCanvasSource(own)).toBe(own);
  });
});

describe('a diagram canvas is exactly what the template writes (HIGH H1)', () => {
  const PLAIN = /This diagram was not saved: a P&ID diagram holds only its data/;

  it('a script before the runtime, foreign content or extra markup is refused in plain words', () => {
    const canvas = sealedCanvas();
    for (const forged of [
      canvas.replace(
        '<script type="module">',
        `<script>document.getElementById('diagram-data').textContent = '{}'</script><script type="module">`,
      ),
      canvas.replace('<main', '<svg><text>CHECKED BY IMAGE</text></svg><main'),
      canvas.replace('</head>', '<script>1</script></head>'),
    ]) {
      let said = '';
      try {
        honestCanvasSource(forged);
      } catch (err) {
        said = (err as Error).message;
      }
      expect(said).toMatch(PLAIN);
      expect(said).not.toMatch(/present_|<script|_create|_update/);
    }
  });

  it('a forged block inside <svg> with encoded keys is refused when it claims the template', () => {
    const page = (meta: string, json: string) =>
      `<!doctype html><html><head>${meta}</head><body><svg><script type="application/json" id="diagram-data">${json}</script></svg><script type="module">import { mount } from '@mantle/diagram-templates/browser';\nmount();</script></body></html>`;
    const json = JSON.stringify({ title: 'x', offpage: [] }).replace('"offpage"', '"&#111;ffpage"');
    expect(() =>
      honestCanvasSource(page('<meta name="diagram:template" content="pid@1">', json)),
    ).toThrow(PLAIN);
    // Claiming nothing it is the author's page: kept, its block written
    // again with no `&`, so a browser reads the stored keys as stored.
    const own = honestCanvasSource(page('', json));
    expect(own).not.toContain('&#');
    expect(own).toContain('\\u0026#111;ffpage');
  });

  it('a canvas that claims no template is refused in its own words, and only for ids a browser finds (LOW f)', () => {
    const page = (extra: string) =>
      `<!doctype html><html><head><title>x</title></head><body>${extra}<script type="application/json" id="diagram-data">{}</script></body></html>`;
    let said = '';
    try {
      honestCanvasSource(page('<pre id="diagram-data">{}</pre>'));
    } catch (err) {
      said = (err as Error).message;
    }
    expect(said).toMatch(/^This canvas was not saved/);
    expect(said).not.toMatch(/diagram's|P&ID/);
    const chart = page('<div id="diagram&amp;chart"></div>');
    expect(() => honestCanvasSource(chart)).not.toThrow();
  });

  it('a sealed canvas comes back byte for byte; a renamed one keeps no check (LOW c)', () => {
    const canvas = sealedCanvas();
    expect(honestCanvasSource(canvas)).toBe(canvas);
    const renamed = canvas.replace('"title": "Traced"', '"title": "Renamed"');
    expect(stateOf(honestCanvasSource(renamed))).toBe('unchecked');
  });
});

describe('the purpose-labelled seal', () => {
  it('holds for its purpose and payload only', () => {
    const sig = sealPayload('pid-crop v1', ['crop1', 'sha']);
    expect(sealPayloadHolds('pid-crop v1', ['crop1', 'sha'], sig)).toBe(true);
    expect(sealPayloadHolds('pid-crop v2', ['crop1', 'sha'], sig)).toBe(false);
    expect(sealPayloadHolds('pid-crop v1', ['crop1', 'other'], sig)).toBe(false);
    expect(() => sealPayload('Bad Purpose!', 1)).toThrow();
  });

  it('is canonical: key order does not matter, null is not missing, non-finite numbers refuse', () => {
    const sig = sealPayload('pid-crop v1', { b: 1, a: [true, null, 'x'], c: { y: 2, x: 1 } });
    expect(
      sealPayloadHolds('pid-crop v1', { c: { x: 1, y: 2 }, a: [true, null, 'x'], b: 1 }, sig),
    ).toBe(true);
    // A null member is not a missing one; an undefined member is missing.
    const withNull = sealPayload('pid-crop v1', { a: 1, b: null });
    expect(sealPayloadHolds('pid-crop v1', { a: 1 }, withNull)).toBe(false);
    expect(
      sealPayloadHolds('pid-crop v1', { a: 1, b: undefined }, sealPayload('pid-crop v1', { a: 1 })),
    ).toBe(true);
    // JSON would write these as null: refused instead, and never held.
    for (const bad of [NaN, Infinity, [1, undefined], undefined, { a: () => 1 }, new Date(0)]) {
      expect(() => sealPayload('pid-crop v1', bad)).toThrow(/drawing seal/);
      expect(sealPayloadHolds('pid-crop v1', bad, sealPayload('pid-crop v1', null))).toBe(false);
    }
    expect(sealPayloadHolds('pid-crop v1', null, sealPayload('pid-crop v1', null))).toBe(true);
  });
});
