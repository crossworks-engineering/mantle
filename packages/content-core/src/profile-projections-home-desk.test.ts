import { describe, expect, it } from 'vitest';
import { HOME_DESK_BYTES_MAX, HOME_DESK_ITEMS_MAX, projectHomeDesk } from './profile-projections';

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
});
