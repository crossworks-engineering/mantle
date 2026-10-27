/**
 * The pictures of `.epub` and `.vsdx` (formats whose pictures came with the
 * parser service) are read for NEW uploads only (images.ts,
 * NEW_UPLOAD_ONLY_IMAGE_EXTS): every picture kept is a vision call when it
 * is indexed, and the owner approved that for files arriving from now on.
 * A file a pass has already read (or skipped) is never opened for them; a
 * new one is, as is one whose bytes changed (a content change drops the
 * byte keys). Other formats are opened as before. Against a real, migrated
 * Postgres (the pass's dedupe query); the byte load is stubbed and records
 * which nodes the pass opened.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/images-new-upload.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('./file-bytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bytes')>();
  return {
    ...actual,
    // Opening a file is loading its bytes: record it, and load none, so the
    // pass stops there (it records why in its own trace, stubbed below).
    loadFileBytes: async (node: { id: string }) => {
      h.opened.push(node.id);
      return null;
    },
  };
});
vi.mock('./trace', () => ({ stepInOwnTrace: async () => undefined }));

describe.skipIf(!URL)('the new-upload-only picture gate (epub, vsdx)', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let maybeExtractEmbeddedImages: typeof import('./images').maybeExtractEmbeddedImages;
  const owner = randomUUID();

  const node = (title: string, data: Record<string, unknown>) =>
    ({
      id: randomUUID(),
      ownerId: owner,
      type: 'file',
      title,
      path: 'files',
      data: { filename: title, ...data },
    }) as unknown as typeof import('@mantle/db').nodes.$inferSelect;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ maybeExtractEmbeddedImages } = await import('./images'));
  }, 60_000);

  afterAll(async () => {
    if (m) await m.closeDb();
  });

  beforeEach(() => {
    h.opened.length = 0;
  });

  for (const ext of ['epub', 'vsdx']) {
    it(`.${ext}: a file already read is not opened`, async () => {
      for (const data of [
        { extract_completed_at: '2026-10-01T00:00:00Z' },
        { indexing_applied: 'full' },
        { extract_skipped: { reason: 'document_unreadable' } },
      ]) {
        const old = node(`manual.${ext}`, data);
        await maybeExtractEmbeddedImages(old, owner, 10);
        expect(h.opened, JSON.stringify(data)).not.toContain(old.id);
      }
      expect(h.opened).toEqual([]);
    });

    it(`.${ext}: a new upload is opened`, async () => {
      const fresh = node(`manual.${ext}`, { sha256: 'a'.repeat(64) });
      await maybeExtractEmbeddedImages(fresh, owner, 10);
      expect(h.opened).toEqual([fresh.id]);
    });
  }

  it('other formats are opened whether or not a pass read them (as before)', async () => {
    const old = node('report.docx', { extract_completed_at: '2026-10-01T00:00:00Z' });
    await maybeExtractEmbeddedImages(old, owner, 10);
    expect(h.opened).toEqual([old.id]);
  });
});
