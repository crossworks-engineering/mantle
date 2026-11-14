/**
 * The step of `drawing-cad`: a DWG, DXF or DGN drawing to its database, its
 * text for search and its picture, from ONE run of the CAD tier
 * (`job.cadRender`), in ONE write call. CAD is the one reader whose three
 * passes share one read (docs/pipelines.md, "The CAD reader as a package"): the brain keeps
 * this one result for the extract (../../../dwg.ts), so a drawing still
 * costs one heavy job.
 *
 * - The request names the file's extension (`file.ext`); the wording and
 *   the sniff follow it. A request with no CAD extension is `failed`.
 * - Bytes that are not that format (the sniff): `ok` with no tabs, as the
 *   old path gave, with no run of the CAD tier. The core gives the same
 *   answer before any job (parseFileSheets), so this is for a run that
 *   reaches the step directly.
 * - A drawing the CAD tier cannot read throws (the job's failure, counted;
 *   the file gets its word after the second count, as before).
 * - Else the tabs, the description, the digest as `text` and the model
 *   space picture (`model.png` in the job's folder) as `pictures`.
 *
 * The options: `dpi`, the box's render dial (DWG_RENDER_DPI, read and sent
 * by the brain; the CAD tier clamps it), and `symbols: false` for a
 * drawing's Table (no Symbols, Placements or Shapes). Neither is a manifest
 * option: they change no row of a file's database.
 *
 * `counts` hold what the brain's readings ask (dwg-reindex --dgn-data,
 * --dwg-reader, --symbols), each 1 or 0; a render that failed while the
 * tabs did not is the one warning.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CAD_EXT_LIST, sniffCad } from '../../../cad-sniff';
import { FILE_TABS_WRITE, type FileTabsWriteInput, type PipelineStep } from '../../contract';
import { CAD_FTS_SKIP_COLUMNS, cadDigest, cadGrids, dwgTableDescription, formatOf } from './cad';
import { cadReplyOf, type DwgRender } from './cad-reply';

/** The picture's file in the job's folder. */
export const CAD_PICTURE = 'model.png';

/** What the readings of the brain ask of one reply, each 1 or 0. */
function factsOf(r: DwgRender): Record<string, number> {
  const bit = (b: unknown) => (b ? 1 : 0);
  return {
    dgn: bit(r.dgn),
    dgn_data_reader: bit(r.dgn?.dataReader),
    dgn_data_error: bit(r.dgn?.dataError),
    dgn_v7: bit(r.dgn?.format?.startsWith('V7')),
    dwg: bit(r.dwg),
    symbols: bit(r.symbols),
  };
}

export const step: PipelineStep = async (req, job) => {
  const ext = req.file?.ext.toLowerCase() ?? '';
  if (!(CAD_EXT_LIST as readonly string[]).includes(ext)) {
    return { status: 'failed', warnings: ['drawing-cad reads a .dwg, .dxf or .dgn file only'] };
  }
  const bytes = await job.bytes();
  const base: FileTabsWriteInput = {
    tabs: [],
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    ftsSkipColumns: CAD_FTS_SKIP_COLUMNS,
  };
  const write = (input: FileTabsWriteInput) => [
    { call: 'tool' as const, tool: FILE_TABS_WRITE, input },
  ];
  if (!sniffCad(bytes, ext)) return { status: 'ok', calls: write(base) };
  const dpi = req.options.dpi;
  const r = cadReplyOf(await job.cadRender(typeof dpi === 'number' ? { dpi } : {}));
  const format = formatOf(ext);
  const grids = cadGrids(r, req.options.symbols !== false);
  const pictures: NonNullable<FileTabsWriteInput['pictures']>[number][] = [];
  if (r.png) {
    await fs.writeFile(path.join(job.dir, CAD_PICTURE), r.png);
    pictures.push({ file: CAD_PICTURE, mime: 'image/png', caption: 'Model space' });
  }
  return {
    status: 'ok',
    calls: write({
      ...base,
      tabs: grids.sheets,
      ...(grids.sheets.length > 0 ? { description: dwgTableDescription(format, grids) } : {}),
      text: cadDigest(r, format),
      pictures,
    }),
    counts: factsOf(r),
    ...(r.renderError ? { warnings: [r.renderError] } : {}),
  };
};
