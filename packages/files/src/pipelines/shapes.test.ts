/**
 * shapesOf on small made-up tab lists: a shape is there when its needed tabs
 * and their needed columns are; optional tabs and columns, and extra ones,
 * change nothing. Pure.
 */
import { describe, expect, it } from 'vitest';
import { SHAPES, shapesOf } from './shapes';

const neededTabs = (id: keyof typeof SHAPES) =>
  SHAPES[id].tabs
    .filter((t) => t.needed)
    .map((t) => ({ name: t.name, columns: [...t.neededColumns] }));

describe('shapesOf', () => {
  it('no tabs, or a plain sheet: no shape', () => {
    expect(shapesOf([])).toEqual([]);
    expect(shapesOf([{ name: 'Sheet1', columns: ['Tag', 'Size'] }])).toEqual([]);
  });

  it('each shape by its needed tabs and columns alone', () => {
    expect(shapesOf(neededTabs('drawing-v1'))).toEqual(['drawing-v1']);
    expect(shapesOf(neededTabs('circuit-v1'))).toEqual(['circuit-v1']);
    expect(shapesOf(neededTabs('pdf-file-v1'))).toEqual(['pdf-file-v1']);
    expect(shapesOf(neededTabs('texts-v1'))).toEqual(['texts-v1']);
    // A Texts tab with no Text column is not texts-v1.
    expect(shapesOf([{ name: 'Texts', columns: ['Layer', 'X'] }])).toEqual([]);
  });

  it('a drawing with symbols and bones has both drawing shapes', () => {
    expect(shapesOf([...neededTabs('drawing-v1'), ...neededTabs('circuit-v1')])).toEqual([
      'drawing-v1',
      'circuit-v1',
    ]);
  });

  it('a needed tab that is missing, or short of a needed column, loses the shape', () => {
    const nodes = neededTabs('circuit-v1').filter((t) => t.name !== 'Segments');
    expect(shapesOf(nodes)).toEqual([]);
    expect(shapesOf([{ name: 'File', columns: ['Kind'] }])).toEqual([]);
    const segments = neededTabs('circuit-v1').map((t) =>
      t.name === 'Segments' ? { ...t, columns: t.columns.filter((c) => c !== 'Node 2') } : t,
    );
    expect(shapesOf(segments)).toEqual([]);
  });

  it('optional tabs and columns are not needed, and extra ones are fine', () => {
    // drawing_redraw reads a missing column as NULL: a Symbols tab is enough.
    expect(shapesOf([{ name: 'Symbols', columns: [] }])).toEqual(['drawing-v1']);
    expect(
      shapesOf([
        { name: 'File', columns: ['Kind', 'Rules kind', 'Pages', 'Something new'] },
        { name: 'Words', columns: ['Text'] },
      ]),
    ).toEqual(['pdf-file-v1']);
  });

  it('every needed column is one of its tab columns', () => {
    for (const shape of Object.values(SHAPES)) {
      for (const t of shape.tabs) {
        for (const c of t.neededColumns) expect(t.columns, `${shape.id} ${t.name}`).toContain(c);
      }
    }
  });
});
