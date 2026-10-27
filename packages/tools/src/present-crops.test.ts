/**
 * The crops a pid canvas embeds when it is saved (present-crops.ts): every
 * check's crop id once, each read by the caller's own read (a stand-in
 * here) only while its bytes are the ones the check recorded (`cropSha`),
 * re-encoded as a small JPEG and sealed, capped in count, reads and
 * size (the canvas cap's room included); what is left out is said. The
 * save keeps a crop only when its seal holds (@mantle/content
 * honestCanvasSource). All ids are made up.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCanvas, CROP_LIMITS, readCanvasAssets } from '@mantle/diagram-templates';
import { cropSealHolds, honestCanvasSource } from '@mantle/content/drawing-seal';
import { CANVAS_MAX_BYTES } from '@mantle/content-core/canvas';
import { cropRoom, embedCheckCrops, embedSealedCheckCrops, type CropRead } from './present-crops';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const ROOM = 900_000;

beforeEach(() => {
  vi.stubEnv('MANTLE_MASTER_KEY', 'present-crops-test-key');
  vi.stubEnv('MANTLE_MASTER_KEY_NEXT', undefined);
});
afterEach(() => vi.unstubAllEnvs());

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const SVG = Buffer.from('<svg/>');
// The hash circuit_verify recorded for each crop: the bytes it stored.
const shaFor = (fileId: string) => sha(fileId === id(3) ? SVG : PNG);
const check = (crops: string[], cropSha: string[] | null = crops.map(shaFor)) => ({
  key: 'k',
  kind: 'valve',
  state: 'checked',
  crops,
  ...(cropSha ? { cropSha } : {}),
});
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

const reads: string[] = [];
const read: CropRead = async (fileId) => {
  reads.push(fileId);
  if (fileId === id(2)) return null; // the caller cannot read it
  if (fileId === id(3)) return { bytes: SVG, mimeType: 'image/svg+xml' };
  return { bytes: PNG, mimeType: 'image/png' };
};

describe('embedCheckCrops', () => {
  it('embeds readable pictures as sealed JPEG data URLs and says what it left out', async () => {
    reads.length = 0;
    const r = await embedCheckCrops(drawing([id(1), id(2), id(3), id(4)]), read, { room: ROOM });
    expect(Object.keys(r.assets!.crops).sort()).toEqual([id(1), id(4)]);
    for (const [fileId, c] of Object.entries(r.assets!.crops)) {
      expect(c.src).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
      expect(cropSealHolds(fileId, c.src, c.sig, sha(PNG))).toBe(true);
      // The seal names the file: another id does not hold.
      expect(cropSealHolds(id(9), c.src, c.sig, sha(PNG))).toBe(false);
      // And the bytes it was made from: another source hash does not hold.
      expect(cropSealHolds(fileId, c.src, c.sig, sha(SVG))).toBe(false);
    }
    expect(r.notes.join(' ')).toMatch(/2 crops named by a check could not be read/);
    expect(reads).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it('embeds a crop only while its file holds the bytes the check stored (M3)', async () => {
    // id 4's file was replaced since the check (a Files upload with replace).
    const other = Buffer.from(PNG);
    other.writeUInt8(other.readUInt8(other.length - 5) ^ 1, other.length - 5);
    const swapped: CropRead = async (fileId) =>
      fileId === id(4) ? { bytes: other, mimeType: 'image/png' } : read(fileId);
    const r = await embedCheckCrops(drawing([id(1), id(2), id(3), id(4)]), swapped, {
      room: ROOM,
    });
    expect(Object.keys(r.assets!.crops)).toEqual([id(1)]);
    expect(r.notes.join(' ')).toMatch(/1 crop file no longer holds the picture/);
  });

  it('a mark with no recorded hash embeds none, and says to check again', async () => {
    reads.length = 0;
    const data = { title: 'Old row', lines: [{ id: 'L1', checks: [check([id(1)], null)] }] };
    const r = await embedCheckCrops(data, read, { room: ROOM });
    expect(r.assets).toBeNull();
    expect(reads).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/filed before crops were bound to their bytes/);
  });

  it('caps the count', async () => {
    const many = Array.from({ length: CROP_LIMITS.count + 3 }, (_, i) => id(100 + i));
    const data = {
      title: 'Many',
      lines: many.map((c, i) => ({ id: `L${i}`, checks: [check([c])] })),
    };
    const r = await embedCheckCrops(data, read, { room: ROOM });
    expect(Object.keys(r.assets!.crops)).toHaveLength(CROP_LIMITS.count);
    expect(r.notes.join(' ')).toMatch(/3 crops did not fit/);
  });

  it('caps the reads: ids that are not pictures still count', async () => {
    reads.length = 0;
    const bad = Array.from({ length: CROP_LIMITS.reads + 5 }, (_, i) => id(300 + i));
    const data = {
      title: 'Bad',
      lines: bad.map((c, i) => ({ id: `L${i}`, checks: [check([c])] })),
    };
    const none: CropRead = async (f) => (reads.push(f), null);
    const r = await embedCheckCrops(data, none, { room: ROOM });
    expect(r.assets).toBeNull();
    expect(reads).toHaveLength(CROP_LIMITS.reads);
    expect(r.notes.join(' ')).toMatch(/5 crops did not fit/);
  });

  it('keeps to the room the canvas cap leaves beside the drawing', async () => {
    const r = await embedCheckCrops(drawing([id(1), id(5), id(6), id(4)]), read, { room: 1_200 });
    // Each crop is a few hundred bytes of base64 plus its entry: some fit.
    const n = Object.keys(r.assets?.crops ?? {}).length;
    expect(n).toBeLessThan(4);
    expect(r.notes.join(' ')).toMatch(/did not fit beside the drawing/);
    // A big drawing: the room is the cap less the source and a margin.
    const big = 'x'.repeat(CANVAS_MAX_BYTES - 10_000);
    expect(cropRoom(big)).toBeLessThan(10_000);
    expect(cropRoom('x'.repeat(CANVAS_MAX_BYTES))).toBe(0);
  });

  it('an update keeps the crops the canvas carries, reading only new ids', async () => {
    const first = await embedCheckCrops(drawing([id(1), id(2), id(3), id(4)]), read, {
      room: ROOM,
    });
    reads.length = 0;
    const r = await embedCheckCrops(drawing([id(1), id(2), id(3), id(7)]), async () => null, {
      room: ROOM,
      have: first.assets,
    });
    // id 1 kept without a read (this caller may not open it); id 7 is new.
    expect(Object.keys(r.assets!.crops)).toEqual([id(1)]);
    expect(r.assets!.crops[id(1)]).toEqual(first.assets!.crops[id(1)]);
  });

  it('an update reads a carried crop again when its seal does not bind the recorded bytes', async () => {
    const first = await embedCheckCrops(drawing([id(1), id(2), id(3), id(4)]), read, {
      room: ROOM,
    });
    reads.length = 0;
    // A later check of the same id recorded other bytes: the carried crop
    // was made from the old ones, so it is not kept; the file is read.
    const data = { title: 'Again', lines: [{ id: 'L1', checks: [check([id(1)], [sha(SVG)])] }] };
    const r = await embedCheckCrops(data, read, { room: ROOM, have: first.assets });
    expect(reads).toEqual([id(1)]);
    expect(r.assets).toBeNull();
    expect(r.notes.join(' ')).toMatch(/no longer holds/);
  });

  it('no master key: nothing sealed, nothing embedded, and said', async () => {
    vi.stubEnv('MANTLE_MASTER_KEY', undefined);
    const r = await embedCheckCrops(drawing([id(1), id(2), id(3), id(4)]), read, { room: ROOM });
    expect(r.assets).toBeNull();
    expect(r.notes.join(' ')).toMatch(/no master key/);
  });

  it('no crop named: no assets block, nothing read', async () => {
    reads.length = 0;
    const r = await embedCheckCrops({ title: 'None', lines: [] }, read, { room: ROOM });
    expect(r).toEqual({ assets: null, notes: [] });
    expect(reads).toEqual([]);
  });
});

describe('embedSealedCheckCrops: the honest pass first', () => {
  it('marks no seal vouches for have no crop read, so none takes the room', async () => {
    reads.length = 0;
    const r = await embedSealedCheckCrops(drawing([id(1), id(2), id(3), id(4)]), read, {
      room: ROOM,
    });
    expect(reads).toEqual([]);
    expect(r).toEqual({ assets: null, notes: [] });
  });
});

describe('a save keeps only sealed crops (honestCanvasSource)', () => {
  it('a crop no surviving mark names goes; another picture under a seal never holds', async () => {
    const data = drawing([id(1), id(2), id(3), id(4)]);
    const { assets } = await embedCheckCrops(data, read, { room: ROOM });
    const html = buildCanvas({ template: 'pid', data, mode: 'import', assets: assets! });
    // The marks here carry no circuit_trace seal, so the save strips their
    // evidence (crops included): every crop goes with them. (The kept case,
    // sealed marks, is present-view.test.ts.)
    expect(readCanvasAssets(html).crops[id(1)]).toBeTruthy();
    expect(honestCanvasSource(html)).not.toContain('diagram-assets');
    const c = assets!.crops[id(1)]!;
    expect(cropSealHolds(id(1), c.src, c.sig, sha(PNG))).toBe(true);
    expect(cropSealHolds(id(1), `${c.src.slice(0, -8)}AAAAAAA=`, c.sig, sha(PNG))).toBe(false);
    expect(cropSealHolds(id(1), c.src, 'f'.repeat(64), sha(PNG))).toBe(false);
  });

  it('refuses an assets block written another way', () => {
    const html = buildCanvas({
      template: 'pid',
      data: drawing([id(1), id(2), id(3), id(4)]),
      mode: 'import',
    });
    const sly = html.replace(
      '</body>',
      '<script id="diagram-assets" type="application/json">{"crops":{}}</script></body>',
    );
    expect(() => honestCanvasSource(sly)).toThrow(/pictures could not be checked/);
  });
});
