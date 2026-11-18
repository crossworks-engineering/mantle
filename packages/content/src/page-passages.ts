/**
 * A file's text by page (docs/pipelines.md, "Page passages", P3): read from
 * its database, where a Reader that says `produces.pages` wrote its tab
 * `Pages` (one row a page: `Page`, the page of the ORIGINAL file, and
 * `Text`), and where an Agent that says `produces.pages` wrote the text of
 * the pages it read by vision (asks keyed `page-<N>`, field `Text`). An
 * Agent's text of a page stands over the Reader's.
 *
 * The file's passages are built from these pages, one section `Page N` a
 * page (server/api/src/agent/extract/index-writes.ts), with no length cap,
 * so `read_section` and `search_chunks` cite the true page of the original
 * file, a book of 1,679 pages too. The text of the file (`data.text`, with
 * its 1 M cap, and the summary) is the same pages joined (pagesText).
 *
 * Read only, with no model and no parser job: the database is the record.
 */
import {
  PAGE_ASK_KEY_PREFIX,
  PAGE_COLUMN,
  PAGE_TEXT_COLUMN,
  PAGES_TAB,
  PIPELINE_STAMP_KEYS,
  fileDbPaths,
  stampOfMeta,
} from '@mantle/files';
import { readDocMeta, scanTabColumns } from '@mantle/tabledb';
import { boxPipelines, type BoxPipelines } from './pipeline-registry';

/** One page of a file's text. */
export type PageText = { page: number; text: string };

/** The most pages read back: past the page cap of an ask (10,000). */
const PAGES_MAX = 10_000;
/** The longest text of one page read back, in characters. */
const PAGE_TEXT_MAX_CHARS = 200_000;

/** The pages of the file's database, and the pages its windows read, or
 *  null when the file has no database of a Reader that says
 *  `produces.pages`. */
export type FilePages = {
  pages: PageText[];
  /** From the database's `_meta` (a windowed Reader): the pages read and
   *  the pages of the file. */
  read?: { read: number; total: number };
};

function pageOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= PAGES_MAX ? n : null;
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/**
 * The text of a file by page, from its database at these bytes: the
 * Reader's `Pages`, with each Agent's page text over it. Null: no
 * database, or its Reader does not say `produces.pages`. A page with no
 * text is left out.
 */
export async function filePagesOf(
  file: { id: string; ownerId: string; sha256: unknown },
  held?: BoxPipelines,
): Promise<FilePages | null> {
  const names = fileDbPaths(file.id, file.sha256);
  if (!names) return null;
  let meta: Readonly<Record<string, string>> | null;
  try {
    meta = readDocMeta(names.sqlite, [
      ...PIPELINE_STAMP_KEYS,
      'pages_read',
      'pages_total',
    ]);
  } catch {
    return null;
  }
  const stamp = stampOfMeta(meta);
  if (!meta || !stamp) return null;
  const pipelines = held ?? (await boxPipelines(file.ownerId));
  const reader = pipelines.byId(stamp.pipeline_id);
  if (!reader || reader.produces.pages !== true) return null;
  const byPage = new Map<number, string>();
  try {
    scanTabColumns(
      names.sqlite,
      PAGES_TAB,
      [PAGE_COLUMN, PAGE_TEXT_COLUMN],
      { maxRows: PAGES_MAX, cellMaxChars: PAGE_TEXT_MAX_CHARS },
      (row) => {
        const page = pageOf(row[PAGE_COLUMN]);
        if (page !== null) byPage.set(page, textOf(row[PAGE_TEXT_COLUMN]));
        return true;
      },
    );
  } catch {
    return null;
  }
  // Each Agent that says `produces.pages`: its text of a page over the
  // Reader's. Its rows are paid answers, kept by a stopped run too (the
  // stamp entry says only whether every ask was answered).
  for (const agent of pipelines.agents) {
    const tab = agent.produces.tabs?.[0];
    if (agent.produces.pages !== true || !tab) continue;
    try {
      scanTabColumns(
        names.sqlite,
        tab,
        ['Key', PAGE_TEXT_COLUMN],
        { maxRows: PAGES_MAX, cellMaxChars: PAGE_TEXT_MAX_CHARS },
        (row) => {
          const key = textOf(row.Key);
          const text = textOf(row[PAGE_TEXT_COLUMN]).trim();
          const page = key.startsWith(PAGE_ASK_KEY_PREFIX)
            ? pageOf(key.slice(PAGE_ASK_KEY_PREFIX.length))
            : null;
          if (page !== null && text !== '') byPage.set(page, text);
          return true;
        },
      );
    } catch {
      // A tab that is not there (the Agent has not run): the Reader's text.
    }
  }
  const pages = [...byPage.entries()]
    .filter(([, text]) => text.trim() !== '')
    .sort((a, b) => a[0] - b[0])
    .map(([page, text]) => ({ page, text }));
  const read = pageOf(meta.pages_read ?? '');
  const total = pageOf(meta.pages_total ?? '');
  return {
    pages,
    ...(total !== null ? { read: { read: Math.min(read ?? 0, total), total } } : {}),
  };
}

/** The heading of one page in a file's text and passages. */
export function pageHeading(page: number): string {
  return `## Page ${page}`;
}

/** The pages as one text, a `## Page N` line before each: the file's text
 *  (`data.text`) and what its passages are cut from. */
export function pagesText(pages: readonly PageText[]): string {
  return pages.map((p) => `${pageHeading(p.page)}\n${p.text.trim()}`).join('\n\n');
}
