/**
 * The canvas data store's one writer (migration 0336,
 * mantle_canvas_data_put) holds its own copy of the caps: pinned here to the
 * contract's constants (@mantle/content-core/canvas-data), so the words a
 * canvas reads never drift from what the database refuses.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CANVAS_DATA_CANVAS_MAX_BYTES,
  CANVAS_DATA_CANVAS_MAX_KEYS,
  CANVAS_DATA_MINE_ALL_MAX_BYTES,
  CANVAS_DATA_MINE_ALL_MAX_KEYS,
  CANVAS_DATA_MINE_MAX_BYTES,
  CANVAS_DATA_MINE_MAX_KEYS,
  CANVAS_DATA_VALUE_MAX_BYTES,
} from '@mantle/content-core/canvas-data';

describe("the canvas data definer's caps", () => {
  it('equal the contract', () => {
    const sql = readFileSync(
      new URL('../../db/migrations/0336_canvas_data.sql', import.meta.url),
      'utf8',
    );
    const constant = (name: string) => {
      const m = new RegExp(`\\b${name} CONSTANT (?:integer|bigint) := (\\d+);`).exec(sql);
      if (!m) throw new Error(`no ${name} in 0336`);
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
