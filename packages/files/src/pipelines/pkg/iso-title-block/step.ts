/**
 * The Agent `iso-title-block` (docs/pipelines.md, "Agents"): it reads the
 * title block of a piping isometric that is a raster or a plot: a scanned
 * TIF, an Imagenation SMF raster or an HP-GL/2 plot.
 *
 * Its one step cuts two pictures of the sheet with no model
 * (`job.sheetPictures`) and returns one vision ask for each: the whole
 * sheet, and the right side, where the title block of these drawings sits,
 * at a sharper scale. Both asks name the same fields, so the tab has one
 * row for each picture. The core makes the paid calls and writes the rows:
 * this step writes nothing, keeps no state and has no second step.
 */
import {
  VISION_WORKER,
  type PipelineAskField,
  type PipelineCall,
  type PipelineStep,
  type SheetPictureSpec,
} from '../../contract';

/** The fields of the tab `Title block`, the same in every ask. */
export const FIELDS: readonly PipelineAskField[] = [
  {
    name: 'Line number',
    hint: 'the piping line number of the isometric, as the title block gives it',
  },
  { name: 'Revision', hint: 'the latest revision of the drawing, a letter or a number' },
  { name: 'Date', hint: 'the date of the latest revision, as it is written' },
  {
    name: 'Sheet',
    hint: 'the sheet number, with the count of sheets when it is given, such as 1 of 3',
  },
  { name: 'Drawn by', hint: 'the name or the initials of the person who drew it' },
  { name: 'Checked by', hint: 'the name or the initials of the person who checked it' },
  {
    name: 'TML total',
    hint: 'the count of thickness measurement locations, when the title block states it',
  },
];

/** The two pictures, each with the key of its ask: the whole sheet, and
 *  the right fifth of it at 200 dots an inch at most. */
const PICTURES: readonly (SheetPictureSpec & { key: string })[] = [
  { key: 'sheet', file: 'sheet.png', part: [0, 0, 1, 1], maxSide: 2800 },
  { key: 'right-side', file: 'right-side.png', part: [0.8, 0, 1, 1], maxSide: 4000, dpiCap: 200 },
];

export const step: PipelineStep = async (req, job) => {
  const got = await job.sheetPictures({
    ext: (req.file?.ext ?? '').toLowerCase(),
    pictures: PICTURES.map(({ file, part, maxSide, dpiCap }) => ({ file, part, maxSide, dpiCap })),
  });
  if (!got) return { status: 'not_mine' };
  // An ask only for a picture the helper wrote.
  const calls: PipelineCall[] = PICTURES.filter((p) => got.pictures.includes(p.file)).map((p) => ({
    call: 'worker',
    worker: VISION_WORKER,
    key: p.key,
    input: { picture: p.file, fields: FIELDS },
  }));
  return { status: 'ok', calls };
};
