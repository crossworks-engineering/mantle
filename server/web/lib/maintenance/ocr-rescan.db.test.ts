/**
 * ocr-rescan on a real, migrated Postgres (lib/maintenance/ocr-rescan.ts):
 * it selects exactly the scans the page-marker bug left behind (a PDF indexed
 * as its markers, a PDF stuck at body_too_short) and nothing else, and its
 * apply clears what the bad pass wrote and reports a batch the agent never
 * finished instead of sending it again. No agent runs here, so no model is
 * ever reached.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/maintenance/ocr-rescan.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('ocr-rescan', () => {
  let m: typeof import('@mantle/db');
  let rescan: typeof import('./ocr-rescan');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  let anchor = '';
  const id = {
    markers: randomUUID(), // a 2-page scan indexed as its markers
    stuck: randomUUID(), // a 1-page scan, body_too_short
    stamped: randomUUID(), // the same, stamped by extract-skip-stamp
    noParser: randomUUID(), // a PDF skipped for another reason
    realText: randomUUID(), // a PDF with a real text layer
    metadata: randomUUID(), // markers, but content indexing is off
    docx: randomUUID(), // body_too_short, not a PDF
  };
  const markers = '-- 1 of 2 --\n\n-- 2 of 2 --';

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    rescan = await import('./ocr-rescan');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    anchor = await ensureTestAnchor(admin as never);
    const file = (nid: string, name: string, data: Row) =>
      admin`insert into nodes (id, owner_id, type, title, path, data) values
        (${nid}, ${anchor}, 'file', ${name}, 'files', ${JSON.stringify(data)}::jsonb)`;
    await file(id.markers, 'scan-a.pdf', {
      filename: 'scan-a.pdf',
      text: markers,
      summary: 'Page markers.',
      extract_completed_at: '2026-09-08T00:00:00Z',
    });
    await file(id.stuck, 'scan-b.pdf', { filename: 'scan-b.pdf' });
    await file(id.stamped, 'scan-c.pdf', {
      filename: 'scan-c.pdf',
      extract_skipped: { reason: 'body_too_short', at: '2026-10-05T00:00:00Z' },
    });
    await file(id.noParser, 'odd.pdf', { filename: 'odd.pdf' });
    await file(id.realText, 'report.pdf', {
      filename: 'report.pdf',
      text: 'Quarterly report\n\n-- 1 of 1 --',
    });
    await file(id.metadata, 'private.pdf', {
      filename: 'private.pdf',
      text: markers,
      indexing: 'metadata',
    });
    await file(id.docx, 'note.docx', { filename: 'note.docx' });
    await admin`insert into traces (owner_id, kind, subject_id, subject_kind, status, data) values
      (${anchor}, 'extractor_run', ${id.stuck}, 'node', 'skipped', '{"disposition":"body_too_short"}'::jsonb),
      (${anchor}, 'extractor_run', ${id.noParser}, 'node', 'skipped', '{"disposition":"pdf_unreadable"}'::jsonb),
      (${anchor}, 'extractor_run', ${id.docx}, 'node', 'skipped', '{"disposition":"body_too_short"}'::jsonb)`;
  });

  afterAll(async () => {
    if (!admin) return;
    const ids = Object.values(id);
    await admin`delete from traces where subject_id = any(${ids}::uuid[])`;
    await admin`delete from nodes where id = any(${ids}::uuid[])`;
    await m.closeDb();
  });

  it('selects the two scan shapes and nothing else', async () => {
    const mine = new Map(
      (await rescan.findRescanCandidates())
        .filter((c) => (Object.values(id) as string[]).includes(c.id))
        .map((c) => [c.id, c.kind]),
    );
    expect(Object.fromEntries(mine)).toEqual({
      [id.markers]: 'markers_indexed',
      [id.stuck]: 'stuck_too_short',
      [id.stamped]: 'stuck_too_short',
    });
  });

  it('clears the bad pass, and reports a batch nobody ran instead of resending it', async () => {
    const batch = [id.markers, id.stamped];
    const r = await rescan.runBatch(batch, { timeoutMs: 50, pollMs: 10 });
    expect(r.done).toEqual([]);
    expect(r.timedOut.sort()).toEqual([...batch].sort());

    const rows = await admin`select id, data from nodes where id = any(${batch}::uuid[])`;
    for (const row of rows) {
      const data = row.data as Row;
      expect(data.text).toBeUndefined();
      expect(data.summary).toBeUndefined();
      expect(data.extract_completed_at).toBeUndefined();
      expect(data.extract_skipped).toBeUndefined();
      expect(data.filename).toBeDefined(); // provenance stays
    }
  });
});
