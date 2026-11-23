/**
 * `file_sql` with no `sql` on a file of many tabs: an overview, not every
 * tab (docs/file-ingestion.md, "File databases"). One rule: past
 * FILE_SQL_TABS_MAX tabs, the tabs that the file's index tab names (the `listedIn` of the shape
 * pages-v1: `Tables`, column `Tab`, a book's table tabs) are counted, not
 * described. The answer says how many, where they are listed, and how to
 * read one. Every other tab is described as before. A file with no such
 * index, or with few tabs, gets null here and answers as before.
 *
 * With the tabs `Links` and `Link nodes` (the Transformer `links`,
 * docs/pipelines.md, "Links"), the overview also says how to follow them:
 * the kinds with their counts, the coverage lines (what the links cover and
 * what could not be read), and a few statements with real ids of this file.
 *
 * One open of the file: a file of thousands of tabs pays its schema once
 * (about 0.6 s at 2,441 tabs). Every statement here is fixed and bounded.
 */
import { SHAPES } from '@mantle/files';
import {
  importMaxRows,
  withTabScanner,
  type TabScanner,
  type WorkbookTabRef,
} from '@mantle/tabledb';
import type { FileDatabaseLinks, FileDatabaseListed } from '@mantle/client-types';

/** Past this many tabs, the tabs an index tab names are counted, not
 *  described. */
export const FILE_SQL_TABS_MAX = 30;

/** The most entries of one list of the link help; past it, the last entry
 *  says how to read them all. */
const LIST_MAX = 60;

const LINKS = 'Links';
const LINK_NODES = 'Link nodes';
const LINKS_COLUMNS = ['from_id', 'to_id', 'kind', 'page', 'source'];
const NODES_COLUMNS = ['id', 'kind', 'label', 'page', 'text'];

export type FileSqlOverview = {
  tabs: WorkbookTabRef[];
  description?: string;
  listed: FileDatabaseListed;
  links?: FileDatabaseLinks;
};

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
const count = (n: number) => n.toLocaleString('en-US');

/** The overview of the file at `abs`, or null: it answers as before. */
export function fileSqlOverview(abs: string): FileSqlOverview | null {
  return withTabScanner(abs, (scan) => {
    const names = scan.names();
    if (names.length <= FILE_SQL_TABS_MAX) return null;
    const index = SHAPES['pages-v1'].listedIn!;
    const indexColumns = scan.columnsOf(index.tab) ?? [];
    if (!indexColumns.includes(index.column)) return null;
    // The index's columns of the shape that the file has: Tab, Title, Pages.
    const shown = (SHAPES['pages-v1'].tabs.find((t) => t.name === index.tab)?.columns ?? []).filter(
      (c) => indexColumns.includes(c),
    );
    const all = new Set(names);
    const listed = new Set<string>();
    // The example: the first listed row, and a word of the first title.
    let first: Record<string, unknown> | undefined;
    let word: string | undefined;
    scan.rows(index.tab, shown, { maxRows: importMaxRows(), cellMaxChars: 1_024 }, (r) => {
      const tab = r[index.column];
      if (typeof tab !== 'string' || tab === index.tab || !all.has(tab)) return true;
      listed.add(tab);
      first ??= r;
      word ??= /[A-Za-z]{3,}/.exec(typeof r.Title === 'string' ? r.Title : '')?.[0];
      return true;
    });
    if (listed.size === 0 || !first) return null;
    const tabs = scan.describe(new Set(names.filter((n) => !listed.has(n))));
    const description = scan.meta('description');
    const links = linkHelpOf(scan, tabs);
    return {
      tabs,
      ...(description !== undefined ? { description } : {}),
      listed: listedOf(scan, listed.size, index, shown, { first, word }),
      ...(links ? { links } : {}),
    };
  });
}

/** The view of a tab, by its name. */
const viewOf = (scan: TabScanner, name: string): string | undefined => {
  const v = scan.all(`SELECT view_name AS v FROM _tabs WHERE name = ?`, name)[0]?.v;
  return typeof v === 'string' ? v : undefined;
};

/** What the answer says of the tabs it counts, with an example: the first
 *  listed row, and a word of the first title. */
function listedOf(
  scan: TabScanner,
  n: number,
  index: { tab: string; column: string },
  shown: readonly string[],
  example: { first: Record<string, unknown>; word: string | undefined },
): FileDatabaseListed {
  const pages = example.first.Pages;
  const where = [
    ...(shown.includes('Title') && example.word
      ? [`"Title" LIKE ${lit(`%${example.word}%`)}`]
      : []),
    ...(shown.includes('Pages') && typeof pages === 'string' && pages !== ''
      ? [`"Pages" = ${lit(pages)}`]
      : []),
  ].join(' OR ');
  const tab = String(example.first[index.column]);
  return {
    count: n,
    in: index.tab,
    how: `${count(n)} more tabs are not described here: the tab ${q(index.tab)} lists them, one row each (${shown.map(q).join(', ')}), ${q(index.column)} being the tab's name. Query a tab by that name.`,
    ...(where
      ? { find: `SELECT ${shown.map(q).join(', ')} FROM ${q(index.tab)} WHERE ${where}` }
      : {}),
    columns: `SELECT * FROM ${q(viewOf(scan, tab) ?? tab)} LIMIT 1`,
  };
}

/** The help for the tabs Links and Link nodes, when the file has both with
 *  their columns. */
function linkHelpOf(
  scan: TabScanner,
  tabs: readonly WorkbookTabRef[],
): FileDatabaseLinks | undefined {
  const tabOf = (name: string, columns: readonly string[]) => {
    const t = tabs.find((x) => x.name === name);
    const have = new Set((t?.columns ?? []).map((c) => c.name));
    return t && columns.every((c) => have.has(c)) ? q(t.viewName) : null;
  };
  const L = tabOf(LINKS, LINKS_COLUMNS);
  const N = tabOf(LINK_NODES, NODES_COLUMNS);
  if (!L || !N) return undefined;

  const kinds = (view: string) => {
    const rows = scan.all(
      `SELECT kind AS k, count(*) AS n FROM ${view} GROUP BY kind ORDER BY n DESC, kind LIMIT ${LIST_MAX + 1}`,
    );
    const out = Object.fromEntries(
      rows.slice(0, LIST_MAX).map((r) => [String(r.k), Number(r.n)]),
    ) as Record<string, number>;
    return { out, more: rows.length > LIST_MAX };
  };
  const linkKinds = kinds(L);
  const nodeKinds = kinds(N);
  const coverageRows = scan.all(
    `SELECT id, label FROM ${N} WHERE kind = 'coverage' AND id <> 'coverage:links'
      AND id NOT LIKE 'coverage:kind:%' ORDER BY _pos LIMIT ${LIST_MAX + 1}`,
  );
  const coverage = coverageRows.slice(0, LIST_MAX).map((r) => String(r.label));
  if (coverageRows.length > LIST_MAX || linkKinds.more || nodeKinds.more) {
    coverage.push(
      `Lists cut at ${LIST_MAX}: all coverage lines with SELECT label FROM ${N} WHERE kind = 'coverage'; all kinds with SELECT kind, count(*) FROM ${L} GROUP BY kind.`,
    );
  }

  // Real ids of this file: a node that links to a row, the row, and what
  // the row links to; with no such chain, any link.
  const chain = (notTable: boolean) =>
    scan.all(
      `SELECT a.from_id AS x, a.to_id AS r, b.to_id AS y, n.label AS label
         FROM ${L} a JOIN ${L} b ON b.from_id = a.to_id JOIN ${N} n ON n.id = b.to_id
        WHERE a.to_id LIKE 'row:%'${notTable ? ` AND a.from_id NOT LIKE 'table:%'` : ''} LIMIT 1`,
    )[0];
  const pair = chain(true) ?? chain(false);
  const any =
    pair ??
    scan.all(
      `SELECT l.to_id AS y, n.label AS label FROM ${L} l JOIN ${N} n ON n.id = l.to_id
        ORDER BY l.kind = 'HAS_PAGE' LIMIT 1`,
    )[0];
  const sql: { for: string; sql: string }[] = [];
  if (any) {
    const y = String(any.y);
    const word = String(any.label ?? '').slice(0, 40) || y.slice(y.indexOf(':') + 1);
    sql.push(
      {
        for: 'nodes by words in their label or text',
        sql: `SELECT id, kind, label, page FROM ${N} WHERE label LIKE ${lit(`%${word}%`)} OR text LIKE ${lit(`%${word}%`)} LIMIT 50`,
      },
      {
        for: `what ${y} links to, and what links to it`,
        sql: `SELECT 'to' AS way, kind, to_id AS other, page FROM ${L} WHERE from_id = ${lit(y)} UNION ALL SELECT 'from', kind, from_id, page FROM ${L} WHERE to_id = ${lit(y)}`,
      },
    );
  }
  if (pair) {
    const x = String(pair.x);
    const y = String(pair.y);
    const r = String(pair.r);
    sql.push({
      for: `two links: the rows of ${x} that link to ${y}`,
      sql: `SELECT r.id, r.page, r.text FROM ${L} a JOIN ${L} b ON b.from_id = a.to_id JOIN ${N} r ON r.id = a.to_id WHERE a.from_id = ${lit(x)} AND b.to_id = ${lit(y)}`,
    });
    const hash = r.lastIndexOf('#');
    const tab = r.slice('row:'.length, hash);
    const n = Number(r.slice(hash + 1));
    const view = viewOf(scan, tab);
    if (hash > 0 && Number.isInteger(n) && n >= 1 && view !== undefined) {
      sql.push({
        for: `a row node to its row: ${r} is row ${n} of its tab`,
        sql: `SELECT * FROM ${q(view)} ORDER BY _pos LIMIT 1 OFFSET ${n - 1}`,
      });
    }
  }
  return {
    about: `${LINKS} holds the links between the things of this file (${LINKS_COLUMNS.join(', ')}), ${LINK_NODES} the things they name (${NODES_COLUMNS.join(', ')}); ids are text, such as page:12, table:<tab>, row:<tab>#<n> (the n-th row of that tab), code:<code>. A row node's text is its cells joined by ' | '.`,
    link_kinds: linkKinds.out,
    node_kinds: nodeKinds.out,
    coverage,
    sql,
    ...('material' in nodeKinds.out
      ? {
          materials: `A material id is the specification number only (mat:A193): ask for a grade with LIKE on the row node's text, e.g. text LIKE '%B7M%'.`,
        }
      : {}),
  };
}
