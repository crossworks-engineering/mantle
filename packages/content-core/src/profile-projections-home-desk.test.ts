import { describe, expect, it } from 'vitest';
import {
  HOME_DESK_BYTES_MAX,
  HOME_DESK_ITEMS_MAX,
  projectHomeDesk,
  validateHomeDeskWrite,
} from './profile-projections';

const desk = (over: Record<string, unknown> = {}) => ({
  v: 1,
  items: [
    { id: 'clock', x: 0, y: 0, w: 3, h: 2 },
    { id: 'kind:notes', x: 0, y: 2, w: 7, h: 3 },
  ],
  counts: { notes: 6 },
  icons: true,
  clock: 'analog',
  ...over,
});

describe('projectHomeDesk', () => {
  it('keeps a well-formed desk as written', () => {
    expect(projectHomeDesk(desk())).toEqual(desk());
  });

  it('keeps an id it does not know: the client owns what a widget is', () => {
    const items = [{ id: 'some-later-widget', x: 1, y: 1, w: 2, h: 2 }];
    expect(projectHomeDesk(desk({ items }))?.items).toEqual(items);
  });

  it('drops a bad item, not the desk', () => {
    const out = projectHomeDesk(
      desk({
        items: [
          { id: 'clock', x: 0, y: 0, w: 3, h: 2 },
          { id: 'clock', x: 5, y: 5, w: 3, h: 2 }, // a repeat keeps the first
          { id: '', x: 0, y: 0, w: 1, h: 1 },
          { id: 'x'.repeat(161), x: 0, y: 0, w: 1, h: 1 },
          { id: 'theme', x: -1, y: 0, w: 1, h: 1 },
          { id: 'focus', x: 0, y: 0, w: 1, h: Number.POSITIVE_INFINITY },
          { id: 'drift', x: '1', y: 0, w: 1, h: 1 },
          null,
          'calendar',
        ],
      }),
    );
    expect(out?.items).toEqual([{ id: 'clock', x: 0, y: 0, w: 3, h: 2 }]);
  });

  it('defaults the settings it cannot read', () => {
    const out = projectHomeDesk({
      v: 1,
      items: [],
      counts: { notes: 'x', '': 3 },
      clock: 'sundial',
    });
    expect(out).toEqual({ v: 1, items: [], counts: {}, icons: true, clock: 'digital' });
  });

  it('is undefined for anything that is not a v1 desk', () => {
    expect(projectHomeDesk(null)).toBeUndefined();
    expect(projectHomeDesk([])).toBeUndefined();
    expect(projectHomeDesk({ v: 2, items: [] })).toBeUndefined();
    expect(projectHomeDesk({ v: 1, items: {} })).toBeUndefined();
  });

  it('caps the items and the size', () => {
    const many = Array.from({ length: HOME_DESK_ITEMS_MAX + 5 }, (_, i) => ({
      id: `pin:${i}`,
      x: 0,
      y: i,
      w: 1,
      h: 1,
    }));
    expect(projectHomeDesk(desk({ items: many }))?.items).toHaveLength(HOME_DESK_ITEMS_MAX);
    const big = Array.from({ length: HOME_DESK_ITEMS_MAX }, (_, i) => ({
      id: `pin:${String(i).padStart(150, '0')}`,
      x: 0,
      y: i,
      w: 1,
      h: 1,
    }));
    expect(JSON.stringify(desk({ items: big })).length).toBeGreaterThan(HOME_DESK_BYTES_MAX);
    expect(projectHomeDesk(desk({ items: big }))).toBeUndefined();
  });

  it('counts the size cap in UTF-8 bytes, not characters', () => {
    const items = (ch: string) =>
      Array.from({ length: 150 }, (_, i) => ({
        id: `${ch.repeat(100)}${i}`,
        x: 0,
        y: i,
        w: 1,
        h: 1,
      }));
    // The same character count either way: under the cap as characters.
    const wide = desk({ items: items('\u20ac') });
    const narrow = desk({ items: items('e') });
    expect(JSON.stringify(wide).length).toBe(JSON.stringify(narrow).length);
    expect(JSON.stringify(wide).length).toBeLessThan(HOME_DESK_BYTES_MAX);
    expect(new TextEncoder().encode(JSON.stringify(wide)).length).toBeGreaterThan(
      HOME_DESK_BYTES_MAX,
    );
    // Three bytes a euro sign: over the cap as stored, so refused whole.
    expect(projectHomeDesk(wide)).toBeUndefined();
    expect(projectHomeDesk(narrow)?.items).toHaveLength(150);
  });
});

describe('validateHomeDeskWrite: strict on write', () => {
  it('keeps a well-formed desk as sent', () => {
    expect(validateHomeDeskWrite(desk())).toEqual(desk());
    // An empty desk on purpose (every widget taken off) is a desk.
    expect(validateHomeDeskWrite(desk({ items: [], counts: {} }))).toEqual(
      desk({ items: [], counts: {} }),
    );
    // Settings left out take their defaults, as on read.
    expect(validateHomeDeskWrite({ v: 1, items: [] })).toEqual({
      v: 1,
      items: [],
      counts: {},
      icons: true,
      clock: 'digital',
    });
  });

  it('refuses a desk with any item the read would drop, never saving what is left', () => {
    const good = { id: 'clock', x: 0, y: 0, w: 3, h: 2 };
    for (const bad of [
      { id: 'clock', x: 5, y: 5, w: 3, h: 2 },
      { id: '', x: 0, y: 0, w: 1, h: 1 },
      { id: 'x'.repeat(161), x: 0, y: 0, w: 1, h: 1 },
      { id: 'theme', x: -1, y: 0, w: 1, h: 1 },
      { id: 'drift', x: '1', y: 0, w: 1, h: 1 },
      null,
      'calendar',
    ]) {
      expect(validateHomeDeskWrite(desk({ items: [good, bad] })), JSON.stringify(bad)).toBe(
        undefined,
      );
    }
    // Garbage alone is not an empty desk.
    expect(validateHomeDeskWrite(desk({ items: [null, 7, 'x'] }))).toBeUndefined();
    // The read keeps what it can of the same desk.
    expect(projectHomeDesk(desk({ items: [good, null] }))?.items).toEqual([good]);
  });

  it('refuses a list the cap would cut', () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `pin:${i}`, x: 0, y: i, w: 1, h: 1 }));
    expect(validateHomeDeskWrite(desk({ items: items(HOME_DESK_ITEMS_MAX) }))?.items).toHaveLength(
      HOME_DESK_ITEMS_MAX,
    );
    expect(validateHomeDeskWrite(desk({ items: items(HOME_DESK_ITEMS_MAX + 1) }))).toBeUndefined();
  });

  it('refuses an id or a key that is not printable ASCII (a NUL, a lone surrogate, a space)', () => {
    for (const id of ['a\u0000b', '\ud800', 'x\udfff', 'has space', 'tab\t', 'café', '€']) {
      const items = [{ id, x: 0, y: 0, w: 1, h: 1 }];
      expect(validateHomeDeskWrite(desk({ items })), JSON.stringify(id)).toBeUndefined();
      expect(validateHomeDeskWrite(desk({ counts: { [id]: 3 } })), JSON.stringify(id)).toBe(
        undefined,
      );
    }
    // The read stays loose: a desk already stored keeps such an id.
    expect(projectHomeDesk(desk({ items: [{ id: 'café', x: 0, y: 0, w: 1, h: 1 }] }))).toBeTruthy();
  });

  it('refuses counts and settings the read would change', () => {
    expect(validateHomeDeskWrite(desk({ counts: { notes: 'x' } }))).toBeUndefined();
    expect(validateHomeDeskWrite(desk({ counts: { notes: -1 } }))).toBeUndefined();
    expect(validateHomeDeskWrite(desk({ counts: [] }))).toBeUndefined();
    expect(validateHomeDeskWrite(desk({ counts: 'notes' }))).toBeUndefined();
    expect(validateHomeDeskWrite(desk({ icons: 'no' }))).toBeUndefined();
    expect(validateHomeDeskWrite(desk({ clock: 'sundial' }))).toBeUndefined();
  });

  it('refuses what is not a v1 desk, and a desk over the size cap', () => {
    expect(validateHomeDeskWrite(null)).toBeUndefined();
    expect(validateHomeDeskWrite({ v: 2, items: [] })).toBeUndefined();
    const big = Array.from({ length: HOME_DESK_ITEMS_MAX }, (_, i) => ({
      id: `pin:${String(i).padStart(150, '0')}`,
      x: 0,
      y: i,
      w: 1,
      h: 1,
    }));
    expect(validateHomeDeskWrite(desk({ items: big }))).toBeUndefined();
  });
});
