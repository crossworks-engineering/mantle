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
  writeFileDatabaseDoc(sqlite, ensureWorkbookDoc({ tabs: tabsOfSheets([sheet]) }), {
    fileId: randomUUID(),
    ownerId: randomUUID(),
  });
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

  it("the reader's state: the decision, the facts mark, and the node's older vision text", () => {
    expect(readerStateOf(null)).toEqual({ decision: null });
    expect(readerStateOf(null, true)).toEqual({ decision: null, facts: true });
    expect(readerStateOf(null, false, true)).toEqual({ decision: null, nodeVision: true });
  });
});
