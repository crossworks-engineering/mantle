/**
 * The crops a pid canvas embeds when it is saved (present-crops.ts): every
 * check's crop id once, each read by the caller's own read (a stand-in
 * here), re-encoded as a small JPEG, capped in count and size; what is left
 * out is said. All ids are made up.
 */
import { describe, expect, it } from 'vitest';
import { CROPS_MAX, cropIdsOf, embedCheckCrops, type CropRead } from './present-crops';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const check = (crops: string[]) => ({ key: 'k', kind: 'valve', state: 'checked', crops });
const drawing = (ids: string[]) => ({
  title: 'Crops',
  offpage: [{ id: 'OPC-1', check: check([ids[0]!]) }],
  lines: [
    {
      id: 'L1',
      checks: [check([ids[1]!]), check([ids[2]!])],
      inline: [{ type: 'gate', check: check([ids[3]!]) }],
    },
  ],
});

describe('cropIdsOf', () => {
  it('finds every check crop once, in a drawing and in a set', () => {
    const ids = [id(1), id(2), id(3), id(4)];
    expect(cropIdsOf(drawing(ids))).toEqual(ids);
    expect(
      cropIdsOf({ pages: [{ data: drawing(ids) }, { data: drawing([id(4), id(5)]) }] }),
    ).toEqual([...ids, id(5)]);
    expect(cropIdsOf({ title: 'none', lines: [{ id: 'L1' }] })).toEqual([]);
    // Not a uuid: never read.
    expect(cropIdsOf(drawing(['../etc', 'x', 'y', 'z']))).toEqual([]);
  });
});

describe('embedCheckCrops', () => {
  const reads: string[] = [];
  const read: CropRead = async (fileId) => {
    reads.push(fileId);
    if (fileId === id(2)) return null; // the caller cannot read it
    if (fileId === id(3)) return { bytes: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' };
    return { bytes: PNG, mimeType: 'image/png' };
  };

  it('embeds readable pictures as JPEG data URLs and says what it left out', async () => {
    reads.length = 0;
    const r = await embedCheckCrops(drawing([id(1), id(2), id(3), id(4)]), read);
    expect(Object.keys(r.assets!.crops).sort()).toEqual([id(1), id(4)]);
    for (const url of Object.values(r.assets!.crops))
      expect(url).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
    expect(r.notes.join(' ')).toMatch(/2 crops named by a check could not be read/);
    expect(reads).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it('caps the count', async () => {
    const many = Array.from({ length: CROPS_MAX + 3 }, (_, i) => id(100 + i));
    const data = {
      title: 'Many',
      lines: many.map((c, i) => ({ id: `L${i}`, checks: [check([c])] })),
    };
    const r = await embedCheckCrops(data, read);
    expect(Object.keys(r.assets!.crops)).toHaveLength(CROPS_MAX);
    expect(r.notes.join(' ')).toMatch(/3 crops did not fit/);
  });

  it('no crop named: no assets block, nothing read', async () => {
    reads.length = 0;
    const r = await embedCheckCrops({ title: 'None', lines: [] }, read);
    expect(r).toEqual({ assets: null, notes: [] });
    expect(reads).toEqual([]);
  });
});
