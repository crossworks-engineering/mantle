/**
 * The canvas data store's one writer (migration 0338,
 * mantle_canvas_data_put) holds its own copy of the caps, and both definers
 * (_put and _delete) their own copy of the key rule: pinned here to the
 * contract's constants (@mantle/content-core/canvas-data), so the words a
 * canvas reads never drift from what the database refuses.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANVAS_DATA_CANVAS_MAX_BYTES,
  CANVAS_DATA_CANVAS_MAX_KEYS,
  CANVAS_DATA_KEY_RE,
  CANVAS_DATA_MINE_ALL_MAX_BYTES,
  CANVAS_DATA_MINE_ALL_MAX_KEYS,
  CANVAS_DATA_MINE_MAX_BYTES,
  CANVAS_DATA_MINE_MAX_KEYS,
  CANVAS_DATA_VALUE_MAX_BYTES,
} from '@mantle/content-core/canvas-data';

const sql = readFileSync(
  new URL('../../db/migrations/0338_canvas_data.sql', import.meta.url),
  'utf8',
);

describe("the canvas data definer's caps", () => {
  it('equal the contract', () => {
    const constant = (name: string) => {
      const m = new RegExp(`\\b${name} CONSTANT (?:integer|bigint) := (\\d+);`).exec(sql);
      if (!m) throw new Error(`no ${name} in 0338`);
      return Number(m[1]);
    };
    expect(constant('value_max')).toBe(CANVAS_DATA_VALUE_MAX_BYTES);
    expect(constant('canvas_max_bytes')).toBe(CANVAS_DATA_CANVAS_MAX_BYTES);
    expect(constant('canvas_max_keys')).toBe(CANVAS_DATA_CANVAS_MAX_KEYS);
    expect(constant('mine_max_bytes')).toBe(CANVAS_DATA_MINE_ALL_MAX_BYTES);
    expect(constant('mine_max_keys')).toBe(CANVAS_DATA_MINE_ALL_MAX_KEYS);
    expect(constant('login_max_bytes')).toBe(CANVAS_DATA_MINE_MAX_BYTES);
    expect(constant('login_max_keys')).toBe(CANVAS_DATA_MINE_MAX_KEYS);
  });
});

describe("the canvas data definers' key rule", () => {
  it('is the contract, in both definers', () => {
    const rules = [...sql.matchAll(/\bin_key !~ '([^']*)'/g)].map((m) => m[1]);
    expect(rules).toEqual([CANVAS_DATA_KEY_RE.source, CANVAS_DATA_KEY_RE.source]);
    expect(CANVAS_DATA_KEY_RE.flags).toBe('');
  });
});
