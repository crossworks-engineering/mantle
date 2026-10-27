/**
 * The zip guard (./zip-guard.ts) measures a part before anything inflates it
 * by reading JSZip's PRIVATE `_data` (the compressed bytes, the method, the
 * declared size). A JSZip release that renames or drops it would leave the
 * guard measuring nothing; these tests fail first: the shape it reads is
 * pinned on the installed JSZip, and a bomb is still refused through it.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { isDocumentTooLarge } from './read-limit';
import { assertZipWithinLimits, loadZip } from './zip-guard';

async function zipOf(files: Record<string, Buffer | string>, store = false): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(files)) {
    zip.file(path, body, { compression: store ? 'STORE' : 'DEFLATE' });
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('JSZip, as the zip guard reads it', () => {
  it('has the private _data the guard measures, for a deflated and a stored part', async () => {
    for (const store of [false, true]) {
      const zip = await JSZip.loadAsync(await zipOf({ 'a.xml': '<a>hello</a>' }, store));
      const entry = zip.file('a.xml')!;
      const data = (entry as unknown as { _data?: Record<string, unknown> })._data;
      expect(data, 'JSZip entry._data').toBeTruthy();
      expect(data!.compressedContent).toBeInstanceOf(Uint8Array);
      expect(typeof data!.compressedSize).toBe('number');
      expect(data!.uncompressedSize).toBe('<a>hello</a>'.length);
      expect((data!.compression as { magic?: string }).magic).toBe(store ? '\x00\x00' : '\x08\x00');
    }
  });

  it('refuses a part that inflates past the cap, read through _data', async () => {
    const bomb = await zipOf({ 'xl/sharedStrings.xml': Buffer.alloc(4 * 1024 * 1024, 0x41) });
    expect(bomb.length).toBeLessThan(64 * 1024);
    const err = await assertZipWithinLimits(bomb, { maxEntryBytes: 1024 * 1024 }).catch(
      (e: unknown) => e,
    );
    expect(isDocumentTooLarge(err)).toBe(true);
    const zip = await loadZip(bomb, { maxEntryBytes: 1024 * 1024 });
    await expect(zip.file('xl/sharedStrings.xml')!.async('string')).rejects.toSatisfy(
      isDocumentTooLarge,
    );
  });

  it('measures the real sizes of a normal file', async () => {
    const sizes = await assertZipWithinLimits(
      await zipOf({ 'a.xml': 'x'.repeat(5000), 'b/c.xml': 'y'.repeat(10) }),
    );
    expect(Object.fromEntries(sizes)).toEqual({ 'a.xml': 5000, 'b/c.xml': 10 });
  });
});
