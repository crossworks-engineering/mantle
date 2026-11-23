/**
 * The core's part of a read again of a PDF (./pdf-read.ts): which stored
 * kind it keeps, and what it tells the reader. A made-up database with a
 * File tab, written as a build writes one; no Postgres.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import { PDF_KIND_RULES_VERSION } from '@mantle/files';
import { tabsOfSheets } from './file-database';
import { pdfReadAgainOf, readerStateOf } from './pdf-read';
import { writeFileDatabaseDoc } from './table-broker';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-read-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A database whose File tab says this kind, by these rules. */
function stored(file: {
  kind: string;
  rulesVersion: number;
  /** `shadow`: a decider answer is stored and not used. */
  source?: 'rules' | 'decider' | 'shadow';
  visionRead?: boolean;
  /** The tab Pages: one row a page, as the page types leave it. */
  pages?: (string | number | null)[][];
  /** The tab Texts: [page, line, text, source] a row (a sketch read's rows
   *  say `ocr`). */
  texts?: [number, number, string, string][];
}) {
  const sqlite = path.join(dir, `${randomUUID()}.sqlite`);
  const names = [
    'Kind',
    'Kind source',
    'Rules kind',
    'Rules version',
    'Decider answer',
    'Vision read',
  ];
  const sheet = {
    name: 'File',
    columns: names.map((name) => ({
      name,
      type:
        name === 'Rules version'
          ? ('number' as const)
          : name === 'Vision read'
            ? ('checkbox' as const)
            : ('text' as const),
    })),
    rows: [
      [
        file.kind,
        file.source === 'decider' ? 'decider' : 'rules',
        file.source === 'decider' ? 'unsure' : file.kind,
        file.rulesVersion,
        file.source === 'decider' ? file.kind : file.source === 'shadow' ? 'pid' : null,
        file.visionRead ?? false,
      ],
    ],
  };
  const pagesSheet = file.pages
    ? [
        {
          name: 'Pages',
          columns: [
            { name: 'Page', type: 'number' as const },
            { name: 'Kind', type: 'text' as const },
            { name: 'Kind from', type: 'text' as const },
            { name: 'Decider kind', type: 'text' as const },
            { name: 'Decider confidence', type: 'number' as const },
          ],
          rows: file.pages,
        },
      ]
    : [];
  const textsSheet = file.texts
    ? [
        {
          name: 'Texts',
          columns: [
            { name: 'Page', type: 'number' as const },
            { name: 'Line', type: 'number' as const },
            { name: 'Text', type: 'text' as const },
            { name: 'Source', type: 'text' as const },
          ],
          rows: file.texts,
        },
      ]
    : [];
  writeFileDatabaseDoc(
    sqlite,
    ensureWorkbookDoc({ tabs: tabsOfSheets([sheet, ...pagesSheet, ...textsSheet]) }),
    {
      fileId: randomUUID(),
      ownerId: randomUUID(),
    },
  );
  return { sqlite, none: path.join(dir, `${randomUUID()}.none`) };
}

describe('a read again of a PDF', () => {
  it('a kind from older rules is named again by the router; one of these rules, or a used decider answer, is kept', async () => {
    const old = await pdfReadAgainOf(stored({ kind: 'unsure', rulesVersion: 1 }));
    expect(old).toMatchObject({ skip: null, reroute: true });
    const now = await pdfReadAgainOf(
      stored({ kind: 'unsure', rulesVersion: PDF_KIND_RULES_VERSION }),
    );
    expect(now).toMatchObject({ skip: null, reroute: false });
    const decided = await pdfReadAgainOf(
      stored({ kind: 'pfd', rulesVersion: 1, source: 'decider' }),
    );
    expect(decided).toMatchObject({ skip: null, reroute: false });
    // A shadow answer was not used: the kind is a rules kind, routed again
    // (the answer stays in the File tab, readRouted).
    const shadow = await pdfReadAgainOf(
      stored({ kind: 'unsure', rulesVersion: 1, source: 'shadow' }),
    );
    expect(shadow).toMatchObject({ skip: null, reroute: true });
    // A database with a sketch read is skipped, as before.
    expect(
      await pdfReadAgainOf(stored({ kind: 'scan', rulesVersion: 1, visionRead: true })),
    ).toEqual({ skip: 'sketch' });
  });

  it("a person's run of one PDF (M4) reads a sketch read again and keeps its paid rows", async () => {
    const names = stored({
      kind: 'scan',
      rulesVersion: 1,
      visionRead: true,
      texts: [
        [1, 1, 'P-101', 'ocr'],
        [1, 2, 'GENERAL NOTES', 'pdf'],
        [2, 1, 'LINE 6"-P-1001', 'ocr'],
      ],
    });
    // Every other read again: skipped, as before.
    expect(await pdfReadAgainOf(names)).toEqual({ skip: 'sketch' });
    const again = await pdfReadAgainOf(names, { sketch: true });
    expect(again).toMatchObject({ skip: null, reroute: true });
    if (again.skip !== null) throw new Error('skipped');
    // The paid words only (Source ocr), with the columns of Texts.
    expect(again.sketch!.rows.map((r) => [r[0], r[1], r[2], r[12]])).toEqual([
      [1, 1, 'P-101', 'ocr'],
      [2, 1, 'LINE 6"-P-1001', 'ocr'],
    ]);
    // A database with no sketch read keeps none.
    const plain = await pdfReadAgainOf(stored({ kind: 'scan', rulesVersion: 1 }), { sketch: true });
    expect(plain).toMatchObject({ skip: null, sketch: null });
  });

  it('a read again takes the stored page types back (M3), with no ask', async () => {
    const again = await pdfReadAgainOf(
      stored({
        kind: 'book',
        rulesVersion: PDF_KIND_RULES_VERSION,
        pages: [
          [1, 'document', 'rules: shadow', 'table', 0.93],
          [2, 'none', 'rules: blank', null, null],
          [3, 'document', 'rules: day cap', null, null],
          [4, 'pid', 'picture', null, null],
        ],
      }),
    );
    expect(again).toMatchObject({
      skip: null,
      pageKinds: [
        {
          page: 1,
          kind: 'document',
          from: 'rules: shadow',
          deciderKind: 'table',
          deciderConfidence: 0.93,
        },
        { page: 2, kind: 'none', from: 'rules: blank', deciderKind: null, deciderConfidence: null },
        {
          page: 3,
          kind: 'document',
          from: 'rules: day cap',
          deciderKind: null,
          deciderConfidence: null,
        },
      ],
    });
    // A database before M3: no page type.
    expect(
      await pdfReadAgainOf(stored({ kind: 'pid', rulesVersion: PDF_KIND_RULES_VERSION })),
    ).toMatchObject({ skip: null, pageKinds: [] });
  });

  it("the reader's state: the decision, the facts mark, and the node's older vision text", () => {
    expect(readerStateOf(null)).toEqual({ decision: null });
    expect(readerStateOf(null, true)).toEqual({ decision: null, facts: true });
    expect(readerStateOf(null, false, true)).toEqual({ decision: null, nodeVision: true });
  });
});
