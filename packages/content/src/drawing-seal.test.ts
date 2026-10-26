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
  markSealBody,
  provenanceSealBody,
  readCanvasData,
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
  return buildCanvas({
    template: 'pid',
    mode: 'import',
    data: {
      title: 'Traced',
      equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
      offpage: [
        {
          id: 'OPC-1',
          direction: 'out',
          sheet: 'S2',
          check: { ...mark, sig: drawingSeal(markSealBody(PROV, mark)) },
        },
      ],
      lines: [{ from: 'V-101', to: 'OPC-1' }],
      checks: { guesses: 1, unchecked: 0, checked: 1, unsure: 0, contradicted: 0, corrected: 0 },
      provenance: { id: PROV, keys, sig: drawingSeal(provenanceSealBody({ id: PROV, keys })) },
    },
  });
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
  it('a canvas with no diagram data is left alone; a second or rewritten block is refused', () => {
    const page = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
    expect(honestCanvasSource(page)).toBe(page);
    const canvas = sealedCanvas();
    const swapped = canvas.replace(
      '<script type="application/json" id="diagram-data">',
      '<script id="diagram-data" type="application/json">',
    );
    expect(() => honestCanvasSource(swapped)).toThrow(/exactly one data block/);
    const second = canvas.replace('<main', '<pre id=diagram-data>{}</pre><main');
    expect(() => honestCanvasSource(second)).toThrow(/exactly one data block/);
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
});
