import { describe, expect, it } from 'vitest';
import {
  CANVAS_DATA_CANVAS_MAX_BYTES,
  CANVAS_DATA_CANVAS_MAX_KEYS,
  CANVAS_DATA_MAX_DEPTH,
  CANVAS_DATA_MINE_ALL_MAX_BYTES,
  CANVAS_DATA_MINE_ALL_MAX_KEYS,
  CANVAS_DATA_VALUE_MAX_BYTES,
  canvasDataValue,
  isCanvasDataBucket,
  isCanvasDataKey,
  isCanvasDataLoginId,
  isCanvasDataOp,
  readCanvasDataJson,
  utf8Bytes,
} from './canvas-data';

describe('canvas data contract', () => {
  it('knows its two buckets and nothing else', () => {
    expect(isCanvasDataBucket('shared')).toBe(true);
    expect(isCanvasDataBucket('mine')).toBe(true);
    for (const b of ['', 'Shared', 'others', 'all', null, 1, {}]) {
      expect(isCanvasDataBucket(b)).toBe(false);
    }
  });

  it('takes a login id as the store gives it: a lowercase uuid', () => {
    expect(isCanvasDataLoginId('00000000-0000-4000-8000-00000000000a')).toBe(true);
    for (const v of ['00000000-0000-4000-8000-00000000000A', 'not-a-uuid', '', null, 1]) {
      expect(isCanvasDataLoginId(v), String(v)).toBe(false);
    }
  });

  it('takes plain keys only', () => {
    for (const k of ['a', 'markup', 'page-2:marks', 'votes/v1', 'A_b.c', 'x'.repeat(128)]) {
      expect(isCanvasDataKey(k), k).toBe(true);
    }
    for (const k of [
      '',
      '-lead',
      '.hidden',
      '/root',
      'x'.repeat(129),
      'a b',
      'a\nb',
      'é',
      '../x',
      'a?b',
      'a#b',
      'a%2F',
      1,
      null,
      ['a'],
    ]) {
      expect(isCanvasDataKey(k), String(k)).toBe(false);
    }
  });

  it('knows its operations', () => {
    expect(isCanvasDataOp('get')).toBe(true);
    expect(isCanvasDataOp('constructor')).toBe(false);
    expect(isCanvasDataOp('__proto__')).toBe(false);
  });

  it('counts UTF-8 bytes as Node does', () => {
    for (const s of ['', 'abc', 'é', '€', '😀', 'a😀b€é', '\ud800', '\udc00x']) {
      expect(utf8Bytes(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length);
    }
  });

  it('reads JSON text and refuses anything else', () => {
    const ok = readCanvasDataJson('{"a":[1,2,{"b":null}]}');
    expect(ok).toEqual({
      ok: true,
      value: { a: [1, 2, { b: null }] },
      text: '{"a":[1,2,{"b":null}]}',
      bytes: 22,
    });
    expect(readCanvasDataJson('{bad')).toEqual({ ok: false, error: 'value must be JSON' });
    expect(readCanvasDataJson(42)).toEqual({ ok: false, error: 'value must be JSON' });
    expect(readCanvasDataJson(undefined)).toEqual({ ok: false, error: 'value must be JSON' });
  });

  it('refuses a value over the cap, counted in bytes', () => {
    const fits = JSON.stringify('x'.repeat(CANVAS_DATA_VALUE_MAX_BYTES - 2));
    expect(readCanvasDataJson(fits).ok).toBe(true);
    const over = JSON.stringify('x'.repeat(CANVAS_DATA_VALUE_MAX_BYTES - 1));
    expect(readCanvasDataJson(over).ok).toBe(false);
    // Fewer characters than the cap, more bytes.
    const wide = JSON.stringify('€'.repeat(CANVAS_DATA_VALUE_MAX_BYTES / 2));
    expect(wide.length).toBeLessThan(CANVAS_DATA_VALUE_MAX_BYTES);
    expect(readCanvasDataJson(wide).ok).toBe(false);
  });

  it('keeps a parsed value only when it is JSON', () => {
    expect(canvasDataValue(undefined).ok).toBe(false);
    expect(canvasDataValue(() => 1).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(canvasDataValue(cyclic).ok).toBe(false);
    expect(canvasDataValue(10n).ok).toBe(false);
    // A Date keeps its JSON form, as JSON.stringify writes it.
    const d = canvasDataValue({ at: new Date(0) });
    expect(d.ok && d.value).toEqual({ at: '1970-01-01T00:00:00.000Z' });
  });

  it('refuses a value nested deeper than the cap', () => {
    const nest = (n: number) => '['.repeat(n) + ']'.repeat(n);
    expect(readCanvasDataJson(nest(CANVAS_DATA_MAX_DEPTH)).ok).toBe(true);
    expect(readCanvasDataJson(nest(CANVAS_DATA_MAX_DEPTH + 1))).toEqual({
      ok: false,
      error: `value nests deeper than ${CANVAS_DATA_MAX_DEPTH} levels`,
    });
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { a: deep };
    expect(canvasDataValue(deep).ok).toBe(false);
    // Wide is fine: depth, not size.
    expect(canvasDataValue({ a: [1, 2, 3], b: { c: [{}, []] } }).ok).toBe(true);
  });

  it('keeps readers to 75% of the canvas', () => {
    expect(CANVAS_DATA_MINE_ALL_MAX_BYTES).toBe((CANVAS_DATA_CANVAS_MAX_BYTES * 3) / 4);
    expect(CANVAS_DATA_MINE_ALL_MAX_KEYS).toBe((CANVAS_DATA_CANVAS_MAX_KEYS * 3) / 4);
  });
});
