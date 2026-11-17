/**
 * The Agent `pdf-sheet-read` (docs/pipelines.md, "The PDF sheet read"): it
 * reads a PDF drawing that the PDF router called a scan, an isometric, an
 * other drawing or unsure. For each page it asks the vision worker for the
 * title block fields and the list of the identifiers on the sheet (tags,
 * line numbers, sheet numbers), into the tabs `Title block` and `Sheet list`.
 *
 * Its one step draws the pictures with no model, in the parser's pdfjs
 * child (`job.pdfPictures`): the whole of each page up to the page cap, and
 * on page 1 the title block corner, at a sharper scale. The corner is the
 * box of the Reader `drawing-pdf` (its options in force reach the step as
 * `state.readerOptions`), so a site that set its box gets the same crop.
 * The kind is the one stored in the file's database (`request.kind`): a
 * file of any other kind is `not_mine`, one parser job and no call.
 *
 * The step writes nothing but its pictures, keeps no state and has no
 * second step: the core makes the paid calls and writes the rows.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { titleBlockOf } from '../../../pdf-rows';
import {
  PIPELINE_ASK_FIELDS_MAX,
  VISION_WORKER,
  type PipelineAskField,
  type PipelineCall,
  type PipelineStep,
} from '../../contract';

/** The kinds of the PDF router this Agent reads: the drawings with no
 *  useful text layer, and the files the rules left unsure. */
export const KINDS: readonly string[] = ['scan', 'isometric', 'unsure', 'other_drawing'];

/** The page cap of the option `pages`, and the most asks of a file: page 1
 *  has two (the whole page and its corner), each page after it one. */
export const PAGES_MAX = 10;
export const ASKS_MAX = PAGES_MAX + 1;

/** The fields of the tab `Title block`, the same on every site. A site adds
 *  its own with the option `more_fields`. */
export const FIELDS: readonly PipelineAskField[] = [
  { name: 'Drawing number', hint: 'the number of the drawing, as the title block gives it' },
  { name: 'Title', hint: 'the title of the drawing, as one line' },
  { name: 'Revision', hint: 'the latest revision of the drawing, a letter or a number' },
  { name: 'Date', hint: 'the date of the latest revision, as it is written' },
  {
    name: 'Sheet',
    hint: 'the sheet number, with the count of sheets when it is given, such as 1 of 3',
  },
  { name: 'Line number', hint: 'the piping line number the drawing is of, when it has one' },
  { name: 'Unit or area', hint: 'the plant unit or area of the drawing' },
  { name: 'Project', hint: 'the project name or number' },
  { name: 'Drawn by', hint: 'the name or the initials of the person who drew it' },
  { name: 'Checked by', hint: 'the name or the initials of the person who checked it' },
];

/** The columns of the Agent's tabs that a field may not take, in lower
 *  case: SQLite takes column names with no regard to case. */
const TAKEN: ReadonlySet<string> = new Set(['key', 'model', 'input hash']);

/**
 * The fields of an ask: {@link FIELDS}, then each word of the option
 * `more_fields` as a field (an `_` is a space), in its order. A word that
 * names a field or a column the tab has already, in any case, is left out,
 * and so is one past PIPELINE_ASK_FIELDS_MAX.
 */
export function fieldsOf(options: Readonly<Record<string, unknown>>): PipelineAskField[] {
  const out: PipelineAskField[] = [...FIELDS];
  const seen = new Set([...TAKEN, ...FIELDS.map((f) => f.name.toLowerCase())]);
  const more = Array.isArray(options.more_fields) ? options.more_fields : [];
  for (const word of more) {
    if (typeof word !== 'string' || out.length >= PIPELINE_ASK_FIELDS_MAX) continue;
    const name = word.replace(/_/g, ' ').trim();
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, hint: `the ${name.toLowerCase()} of the drawing, as it is written` });
  }
  return out;
}

/** The pages the step reads: the option `pages`, 1 to PAGES_MAX. */
export function pagesOf(options: Readonly<Record<string, unknown>>): number {
  const n = options.pages;
  return typeof n === 'number' && Number.isInteger(n) ? Math.min(PAGES_MAX, Math.max(1, n)) : 10;
}

/** The pictures. A whole page at 200 dots an inch, its longest side 4800
 *  pixels at most; the corner at 300. The old whole-page read, which read
 *  the most line numbers in the P0 score, drew at 144, and an A0 sheet at
 *  about 110 under its pixel cap: 4800 gives an A0 108, and an A4 or A3
 *  sheet (28 of the 29 pages of that set) is under the cap at 200. A
 *  picture is a PNG, or a JPEG when the PNG is past 5 MB: 11 pictures stay
 *  under the parser's answer budget (64 MB), and each under the 10 MB of an
 *  ask. */
export const PAGE_DPI = 200;
export const CORNER_DPI = 300;
export const MAX_SIDE = 4800;
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;

const isPng = (b: Buffer) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50;
/** The file name of a picture, by its type. */
const fileOf = (name: string, bytes: Buffer) => `${name}.${isPng(bytes) ? 'png' : 'jpg'}`;

/** The corner of a sheet of `widthMm` x `heightMm` that the title block box
 *  takes, as fractions from the top left of the shown page. */
export function cornerOf(
  widthMm: number,
  heightMm: number,
  box: { width: number; height: number },
): [number, number, number, number] {
  const x0 = Math.max(0, 1 - box.width / widthMm);
  const y0 = Math.max(0, 1 - box.height / heightMm);
  return [x0, y0, 1, 1];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const step: PipelineStep = async (req, job) => {
  const ext = (req.file?.ext ?? '').toLowerCase();
  if (ext !== 'pdf' || req.kind === undefined || !KINDS.includes(req.kind)) {
    return { status: 'not_mine' };
  }
  const fields = fieldsOf(req.options);
  const pages = pagesOf(req.options);
  const readerOptions =
    isObject(req.state) && isObject(req.state.readerOptions) ? req.state.readerOptions : {};
  const box = titleBlockOf(readerOptions);
  const whole = (pageNumber: number) => ({
    pageNumber,
    scale: PAGE_DPI / 72,
    maxSide: MAX_SIDE,
    maxBytes: PICTURE_MAX_BYTES,
  });

  // Page 1 first: its size on paper places the corner.
  const [first] = await job.pdfPictures([whole(1)], job.deadline);
  if (!first) return { status: 'ok', calls: [], warnings: ['Page 1 could not be drawn.'] };
  const later = Array.from({ length: pages - 1 }, (_, i) => whole(i + 2));
  const [corner, ...rest] = await job.pdfPictures(
    [
      {
        pageNumber: 1,
        box: cornerOf(first.widthMm, first.heightMm, box),
        scale: CORNER_DPI / 72,
        maxSide: MAX_SIDE,
        maxBytes: PICTURE_MAX_BYTES,
      },
      ...later,
    ],
    job.deadline,
  );

  const calls: PipelineCall[] = [];
  const warnings: string[] = [];
  const add = async (
    key: string,
    page: number,
    picture: { png: Buffer } | null | undefined,
    list: boolean,
  ) => {
    if (!picture) return;
    if (picture.png.length > PICTURE_MAX_BYTES) {
      warnings.push(`The picture ${key} is over 5 MB, and is not read.`);
      return;
    }
    const file = fileOf(key, picture.png);
    await fs.writeFile(path.join(job.dir, file), picture.png);
    calls.push({
      call: 'worker',
      worker: VISION_WORKER,
      key,
      input: { picture: file, fields, page, ...(list ? { list: true } : {}) },
    });
  };
  await add('page-1', 1, first, true);
  await add('page-1-title-block', 1, corner, false);
  for (const [i, picture] of rest.entries()) await add(`page-${i + 2}`, i + 2, picture, true);
  return { status: 'ok', calls, ...(warnings.length > 0 ? { warnings } : {}) };
};
