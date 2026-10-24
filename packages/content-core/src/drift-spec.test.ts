import { describe, expect, it } from 'vitest';
import { FRESH_APPEARANCE } from '@mantle/client-types/fresh-appearance';
import {
  DRIFT_SPEC_DEFAULTS,
  DRIFT_SPEC_MAX,
  decodeDriftSpec,
  encodeDriftSpec,
  randomDriftSpec,
  type DriftSpec,
} from './drift-spec';

const V2: DriftSpec = {
  ...DRIFT_SPEC_DEFAULTS,
  seed: 123456,
  style: 'marble',
  pal: 'chart',
  tone: 'lighter',
  speed: 3.5,
  angle: -45,
};

describe('the Drift spec codec', () => {
  it('decodes a Neat v1 spec as silk, keeping seed, tone and speed', () => {
    const spec = decodeDriftSpec('{"v":1,"seed":7,"tone":"darker","speed":4}');
    expect(spec).toEqual({
      ...DRIFT_SPEC_DEFAULTS,
      seed: 7,
      tone: 'darker',
      speed: 4,
      style: 'silk',
    });
  });

  it('decodes the fresh-install default (still v1)', () => {
    expect(decodeDriftSpec(FRESH_APPEARANCE.neatBackground)?.style).toBe('silk');
  });

  it('round-trips v2 through its canonical encoding', () => {
    const wire = encodeDriftSpec(V2);
    expect(decodeDriftSpec(wire)).toEqual(V2);
    expect(encodeDriftSpec(decodeDriftSpec(wire)!)).toBe(wire);
    expect(JSON.parse(wire).v).toBe(2);
  });

  it('encodes v1 input as v2', () => {
    const spec = decodeDriftSpec('{"v":1,"seed":7,"tone":"auto","speed":2}')!;
    expect(JSON.parse(encodeDriftSpec(spec))).toMatchObject({ v: 2, style: 'silk', seed: 7 });
  });

  it('keeps the largest spec under the storage cap', () => {
    const big = randomDriftSpec({ ...V2, seed: 0xffffffff, scale: 0.33, str: 0.33, angle: -179 });
    expect(encodeDriftSpec({ ...big, seed: 0xffffffff }).length).toBeLessThan(DRIFT_SPEC_MAX);
  });

  it('reads garbage as off (null), never a throw', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      '   ',
      'not json',
      '[]',
      'null',
      '{"v":2}',
      '{"v":3,"seed":1}',
      '{"v":2,"seed":-1}',
      '{"v":2,"seed":1.5}',
      '{"v":1,"seed":1,"tone":"neon","speed":2}',
      '{"v":1,"seed":1,"tone":"auto","speed":-1}',
      'x'.repeat(DRIFT_SPEC_MAX + 1),
    ]) {
      expect(decodeDriftSpec(bad)).toBeNull();
    }
  });

  it('clamps out-of-range numbers and unknown enums to the defaults', () => {
    const spec = decodeDriftSpec(
      '{"v":2,"seed":1,"speed":99,"style":"plasma","str":5,"angle":720}',
    );
    expect(spec).toMatchObject({ speed: 6, style: 'mesh', str: 1, angle: 180 });
  });
});
