/**
 * The step of `plot-dwfx`: an Autodesk DWFx plot set (the XPS form of a DWF
 * set) to its file database, the tabs Sheets and Texts, with the
 * description of a DWFx database. One step, one write call. It runs in the
 * parser job `pipelineRun`. The reader is ./dwfx.ts, which the
 * text read (../../../read-document.ts, the job `text`) uses too.
 *
 * - Not a DWFx (not a zip, or a zip with no page): `ok` with no tabs. The
 *   write spot gives the word `no-rows`.
 * - A DWFx that cannot be opened, or whose every page is missing, throws: a
 *   failed job, counted, and the file gets its word after the second count.
 * - Else the two tabs and the description.
 *
 * Its own package, not a match of `plot-dwf`: a new extension there would
 * raise that package's version and show every DWF file as stale.
 */
import type { ParsedSheet } from '../../../sheet-to-grid';
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import { parseDwfxStructured, type DwfxSheet } from './dwfx';

export const step: PipelineStep = async (_req, job) => {
  const parsed = await parseDwfxStructured(await job.bytes());
  if (!parsed) return { status: 'ok' };
  const tabs = dwfxGrids(parsed.sheets);
  return {
    status: 'ok',
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: tabs.length > 0 ? { tabs, description: DWFX_DESCRIPTION } : { tabs },
      },
    ],
  };
};

/** Sheets: one row a sheet. Texts: every text run, in page order. [] for a
 *  set with no text and no sheet title (all linework and pictures). */
export function dwfxGrids(sheets: DwfxSheet[]): ParsedSheet[] {
  if (sheets.every((s) => s.runs.length === 0 && s.title === null)) return [];
  const nameOf = (s: DwfxSheet, i: number) => s.title ?? `Sheet ${i + 1}`;
  return [
    {
      name: 'Sheets',
      columns: [
        { name: 'Sheet', type: 'text' },
        { name: 'Page', type: 'number' },
        { name: 'Source drawing', type: 'text' },
        { name: 'Layout', type: 'text' },
        { name: 'Author', type: 'text' },
        { name: 'Text runs', type: 'number' },
        { name: 'Read', type: 'text' },
      ],
      rows: sheets.map((s, i) => [
        nameOf(s, i),
        i + 1,
        s.sourceFile,
        s.layout,
        s.author,
        s.runs.length,
        s.unreadable ? 'missing or damaged' : 'read',
      ]),
    },
    {
      name: 'Texts',
      columns: [
        { name: 'Sheet', type: 'text' },
        { name: 'Page', type: 'number' },
        { name: 'Order', type: 'number' },
        { name: 'Text', type: 'text' },
      ],
      rows: sheets.flatMap((s, i) => s.runs.map((text, k) => [nameOf(s, i), i + 1, k + 1, text])),
    },
  ];
}

/** What a reader of a DWFx database's tabs must know before a query. */
export const DWFX_DESCRIPTION =
  `Autodesk DWFx plot set (XPS). Sheets is one row per sheet, with the source` +
  ` drawing named in it; Texts is every text run on a sheet, in page order` +
  ` (title block, tags, notes). The linework and the page pictures are not in` +
  ` these tabs: read the Source drawing for geometry.`;
