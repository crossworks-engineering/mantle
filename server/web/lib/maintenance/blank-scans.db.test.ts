/**
 * blank-scans on a real, migrated Postgres (lib/maintenance/blank-scans.ts):
 * the finder lists exactly the PDFs page OCR read, and the prepare step
 * clears a file and stamps it in one go, so a second run never lists it. No
 * agent runs here, so no model is ever reached.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/maintenance/blank-scans.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('blank-scans', () => {
  let m: typeof import('@mantle/db');
  let blank: typeof import('./blank-scans');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  let anchor = '';
  const tag = randomUUID().slice(0, 8);
  const id = {
    noText: randomUUID(), // page OCR read nothing: terminal no_text_layer
    ocrText: randomUUID(), // page OCR read a sentence, indexed
    byMime: randomUUID(), // no .pdf name, a PDF by its type
    native: randomUUID(), // read natively: no render ran
    sent: randomUUID(), // stamped by an earlier run
    textLayer: randomUUID(), // a PDF with its own text
    metadata: randomUUID(), // content indexing is off
    applied: randomUUID(), // content indexing was turned off, as applied
    image: randomUUID(), // OCR of a picture, not a PDF
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    blank = await import('./blank-scans');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    anchor = await ensureTestAnchor(admin as never);
    // Names of this file's own: test files run side by side on one database,
    // and a name is unique in its folder.
    const file = (nid: string, name: string, data: Row) => {
      const own = `bs-${tag}-${name}`;
      const body = { ...data, filename: own };
      return admin`insert into nodes (id, owner_id, type, title, path, data) values
        (${nid}, ${anchor}, 'file', ${own}, 'files', ${JSON.stringify(body)}::jsonb)`;
    };
    await file(id.noText, 'scan-a.pdf', {
      filename: 'scan-a.pdf',
      extract_skipped: { reason: 'no_text_layer', at: '2026-09-01T00:00:00Z' },
    });
    await file(id.ocrText, 'scan-b.pdf', {
      filename: 'scan-b.pdf',
      ocr: true,
      text: 'The page is blank.',
      summary: 'A blank page.',
      extract_completed_at: '2026-09-02T00:00:00Z',
    });
    await file(id.byMime, 'upload-123', {
      filename: 'upload-123',
      mimeType: 'application/pdf',
      ocr: true,
      extract_completed_at: '2026-11-05T00:00:00Z',
    });
    await file(id.native, 'scan-c.pdf', {
      filename: 'scan-c.pdf',
      ocr: true,
      native_pdf: true,
      extract_completed_at: '2026-09-03T00:00:00Z',
    });
    await file(id.sent, 'scan-d.pdf', {
      filename: 'scan-d.pdf',
      extract_skipped: { reason: 'no_text_layer', at: '2026-09-04T00:00:00Z' },
      blank_scan_reread: '2026-11-02T00:00:00Z',
    });
    await file(id.textLayer, 'report.pdf', {
      filename: 'report.pdf',
      text: 'Quarterly report',
      extract_completed_at: '2026-09-05T00:00:00Z',
    });
    await file(id.metadata, 'private.pdf', {
      filename: 'private.pdf',
      extract_skipped: { reason: 'no_text_layer', at: '2026-09-06T00:00:00Z' },
      indexing: 'metadata',
    });
    await file(id.applied, 'private-2.pdf', {
      extract_skipped: { reason: 'no_text_layer', at: '2026-09-06T00:00:00Z' },
      indexing_applied: 'metadata',
    });
    await file(id.image, 'photo.png', {
      filename: 'photo.png',
      ocr: true,
      extract_completed_at: '2026-09-07T00:00:00Z',
    });
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const ids = Object.values(id);
    await admin`delete from nodes where id = any(${ids}::uuid[])`;
    await m.closeDb();
  });

  const mine = async () =>
    Object.fromEntries(
      (await blank.findBlankCandidates())
        .filter((c) => (Object.values(id) as string[]).includes(c.id))
        .map((c) => [c.id, `${c.kind} ${c.readAt} ${c.textChars}`]),
    );

  it('lists the PDFs page OCR read, with when, and nothing else', async () => {
    expect(await mine()).toEqual({
      [id.noText]: 'no_text 2026-09-01T00:00:00Z 0',
      [id.ocrText]: 'ocr_text 2026-09-02T00:00:00Z 18',
      [id.byMime]: 'ocr_text 2026-11-05T00:00:00Z 0',
    });
  });

  it('clears a file and stamps it in one step, so a second run leaves it out', async () => {
    const at = new Date('2026-11-10T12:00:00Z');
    expect(await blank.prepareReread(id.ocrText, at)).toBe(true);
    const [row] = await admin`select data from nodes where id = ${id.ocrText}`;
    const data = row!.data as Row;
    expect(data.text).toBeUndefined();
    expect(data.summary).toBeUndefined();
    expect(data.ocr).toBeUndefined();
    expect(data.extract_completed_at).toBeUndefined();
    expect(data.filename).toBe(`bs-${tag}-scan-b.pdf`); // provenance stays
    expect(data.blank_scan_reread).toBe('2026-11-10T12:00:00.000Z');
    // The extractor reads it again by page OCR, as it would: the stamp keeps
    // it off the next run's list.
    await admin`update nodes set data = data || '{"ocr": true, "extract_completed_at": "2026-11-10T12:05:00Z"}'::jsonb
      where id = ${id.ocrText}`;
    expect(Object.keys(await mine()).sort()).toEqual([id.noText, id.byMime].sort());
  });

  it('sends nothing when the file is no longer a candidate at its turn', async () => {
    const before =
      await admin`select id, data from nodes where id = any(${[id.sent, id.textLayer, id.native]}::uuid[]) order by id`;
    // Stamped by another run, a PDF with its own text, a native read.
    for (const nid of [id.sent, id.textLayer, id.native])
      expect(await blank.prepareReread(nid, new Date()), nid).toBe(false);
    const after =
      await admin`select id, data from nodes where id = any(${[id.sent, id.textLayer, id.native]}::uuid[]) order by id`;
    expect(after).toEqual(before);
  });
});
