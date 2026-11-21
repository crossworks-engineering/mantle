/**
 * Links: the links between the things of a file database, from the tabs a
 * Reader wrote, by fixed patterns. Pure: the tabs in, two sheets out
 * (`Links` and `Link nodes`). No model, no I/O. The `after` pipeline
 * `links` (../../builtin.ts) runs it in its step (./step.ts), on the tabs of
 * the shape `pages-v1` (../../shapes.ts), never on the file itself
 * (docs/pipelines.md, "Links").
 *
 * Two layers of rules:
 *  - the generic rules here, for any file of pages or tables: HAS_PAGE,
 *    TABLE_ON_PAGE, HAS_ROW, NAMES_CODE, NAMES_TAG, NAMES_LINE, REFERS_TO;
 *  - rule packs for a kind of document (./packs.ts), each switched on by a
 *    count of its own patterns.
 *
 * Ids are text, made here, never by SQL and never from a number's printed
 * form: `page:12`, `table:<tab>`, `row:<tab>#7`, `code:<code>`,
 * `tag:<tag>`, `line:<line>`, `note:<n>`, `coverage:<what>`.
 *
 * Honesty: the nodes of kind `coverage` say what the links are, how many of
 * each kind there are, and what could not be read (pages with no text, page
 * texts cut before the read, tables the body did not hold, a cap reached).
 *
 * A file is outside input, so every loop is bounded: a text is cut at
 * AFTER_CELL_MAX_CHARS by the core before it gets here, and the two tabs
 * hold at most LINKS_ROWS_MAX and LINK_NODES_ROWS_MAX rows; past them the
 * rest is not written, and a coverage node and a warning say so.
 */
import { AFTER_CELL_MAX_CHARS } from '../../shapes';
import type { ParsedSheet } from '../../../sheet-to-grid';
import {
  parseEquipmentTag,
  parseInstrumentTag,
  parseLineNumber,
  tokenItems,
  tokensOf,
} from '../../../pdf-tags';

/** The names of the two tabs Links writes. */
export const LINKS_TAB = 'Links';
export const LINK_NODES_TAB = 'Link nodes';
/** The most rows of each tab. */
export const LINKS_ROWS_MAX = 400_000;
export const LINK_NODES_ROWS_MAX = 200_000;
/** The columns of the two tabs kept out of the search shadow: ids, kinds
 *  and sources are no words to search, and a row's text is searched in its
 *  own tab already. Only a node's label is searched. */
export const LINKS_FTS_SKIP: readonly string[] = [
  'from_id',
  'to_id',
  'kind',
  'source',
  'id',
  'text',
];
/** The longest text of a node (a row's cells), in characters. */
export const NODE_TEXT_MAX = 400;
/** The longest page list a coverage node spells out, in characters. */
const PAGE_LIST_MAX = 2_000;

type Cell = string | number | boolean | null;

/** One tab of the body: its columns and its rows, in the columns' order. */
export type BodyTab = { columns: readonly string[]; rows: readonly (readonly unknown[])[] };

/** A page of the file: its number and its text (the Reader's, or the
 *  Agent's for a page the Reader had no text of). */
export type LinkPage = {
  page: number;
  text: string;
  /** Where the text came from: `Pages`, `Page text` or '' for none. */
  from: string;
  /** The text reached the cell cap: it was cut before the read. */
  cut: boolean;
};

/** One row of a table tab, as the rules see it. */
export type LinkRow = {
  id: string;
  tab: string;
  /** 1-based, in the tab's order. */
  n: number;
  page: number | null;
  columns: readonly string[];
  /** The cells as text, '' for none, in the order of `columns`. */
  cells: readonly string[];
  /** The cells but Page, joined by ' | '. */
  text: string;
  /** The codes the generic rule found in the row (NAMES_CODE). */
  codes: Set<string>;
};

/** One table of the file: its tab, title and pages. */
export type LinkTable = {
  id: string;
  tab: string;
  title: string;
  first: number | null;
  last: number | null;
  rows: LinkRow[];
};

/** What the rules read: the pages in page order, the tables in the order
 *  of their first page, the rows of each, and what the body lacked. */
export type LinkInput = {
  pages: LinkPage[];
  tables: LinkTable[];
  /** A drawing's Tags and Lines rows (the Reader's own read of them). */
  tags: { page: number | null; tag: string; type: string; n: number }[];
  lines: { page: number | null; line: string; n: number }[];
  /** Tabs named in Tables that the body did not hold. */
  tablesNotRead: string[];
};

/** A cell as text: a string as it is, a finite number in its shortest
 *  form (12, never 12.0), anything else ''. */
const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
};

/** A page number from a cell: a whole number of 1 or more, else null. A
 *  number column is a REAL, so 12 may come as 12 or '12'. */
export function pageOf(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** The ids, made in one place. */
export const ids = {
  file: () => 'file',
  page: (n: number) => `page:${n}`,
  table: (tab: string) => `table:${tab}`,
  row: (tab: string, n: number) => `row:${tab}#${n}`,
  code: (code: string) => `code:${code}`,
  tag: (tag: string) => `tag:${tag}`,
  line: (line: string) => `line:${line}`,
  note: (n: string) => `note:${n}`,
  coverage: (what: string) => `coverage:${what}`,
};

/** The pages a Tables cell names: `12`, `12-14`, `12 on`. */
export function pagesOfCell(v: unknown): { first: number; last: number } | null {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?/.exec(text(v));
  if (!m) return null;
  const first = Number(m[1]);
  const last = m[2] ? Number(m[2]) : first;
  return first >= 1 && last >= first ? { first, last } : null;
}

/** The rules' input from the body's tabs (./step.ts parses the body). */
export function linkInputOf(tabs: ReadonlyMap<string, BodyTab>): LinkInput {
  const col = (t: BodyTab | undefined, name: string) => (t ? t.columns.indexOf(name) : -1);
  const pagesTab = tabs.get('Pages');
  const agentTab = tabs.get('Page text');
  const agentText = new Map<number, string>();
  if (agentTab) {
    const k = col(agentTab, 'Key');
    const t = col(agentTab, 'Text');
    for (const r of agentTab.rows) {
      const m = /^page-(\d+)$/.exec(text(r[k]));
      const value = text(r[t]);
      if (m && value.trim() !== '') agentText.set(Number(m[1]), value);
    }
  }
  const pages = new Map<number, LinkPage>();
  if (pagesTab) {
    const p = col(pagesTab, 'Page');
    const t = col(pagesTab, 'Text');
    for (const r of pagesTab.rows) {
      const page = pageOf(r[p]);
      if (page === null || pages.has(page)) continue;
      const own = t >= 0 ? text(r[t]) : '';
      const agent = agentText.get(page) ?? '';
      const use = own.trim() !== '' ? own : agent;
      pages.set(page, {
        page,
        text: use,
        from: use === '' ? '' : use === own ? 'Pages' : 'Page text',
        cut: use.length >= AFTER_CELL_MAX_CHARS,
      });
    }
  }

  const tables: LinkTable[] = [];
  const tablesNotRead: string[] = [];
  const index = tabs.get('Tables');
  if (index) {
    const tabCol = col(index, 'Tab');
    const titleCol = col(index, 'Title');
    const pagesCol = col(index, 'Pages');
    const seen = new Set<string>();
    for (const r of index.rows) {
      const tab = text(r[tabCol]);
      if (tab === '' || seen.has(tab)) continue;
      seen.add(tab);
      const body = tabs.get(tab);
      if (!body) {
        tablesNotRead.push(tab);
        continue;
      }
      const span = pagesOfCell(r[pagesCol]);
      const table: LinkTable = {
        id: ids.table(tab),
        tab,
        title: text(r[titleCol]).trim(),
        first: span?.first ?? null,
        last: span?.last ?? null,
        rows: [],
      };
      const pageCol = body.columns.indexOf('Page');
      body.rows.forEach((cellsIn, i) => {
        const cells = body.columns.map((_, c) => text(cellsIn[c]).trim());
        const rest = cells.filter((_, c) => c !== pageCol && cells[c] !== '');
        table.rows.push({
          id: ids.row(tab, i + 1),
          tab,
          n: i + 1,
          page: (pageCol >= 0 ? pageOf(cellsIn[pageCol]) : null) ?? table.first,
          columns: body.columns,
          cells,
          text: rest.join(' | ').replace(/\s+/g, ' '),
          codes: new Set(),
        });
      });
      tables.push(table);
    }
    tables.sort((a, b) => (a.first ?? 0) - (b.first ?? 0));
  }

  const tags: LinkInput['tags'] = [];
  const tagsTab = tabs.get('Tags');
  if (tagsTab) {
    const [p, t, ty] = ['Page', 'Tag', 'Type'].map((c) => col(tagsTab, c));
    tagsTab.rows.forEach((r, i) => {
      const tag = text(r[t!]).trim();
      if (tag !== '') tags.push({ page: pageOf(r[p!]), tag, type: text(r[ty!]), n: i + 1 });
    });
  }
  const lines: LinkInput['lines'] = [];
  const linesTab = tabs.get('Lines');
  if (linesTab) {
    const [p, l] = ['Page', 'Line number'].map((c) => col(linesTab, c));
    linesTab.rows.forEach((r, i) => {
      const line = text(r[l!]).trim();
      if (line !== '') lines.push({ page: pageOf(r[p!]), line, n: i + 1 });
    });
  }
  return {
    pages: [...pages.values()].sort((a, b) => a.page - b.page),
    tables,
    tags,
    lines,
    tablesNotRead,
  };
}

/** The source of a link: the rule, the tab and the row it came from. */
export const sourceOf = (rule: string, tab: string, row?: number): string =>
  row === undefined ? `${rule}: ${tab}` : `${rule}: ${tab} #${row}`;

/** The builder of the two tabs: nodes by id (the first wins), links with no
 *  repeat of one (from, to, kind, page), each within its cap. */
export class LinkSet {
  readonly nodes = new Map<string, Cell[]>();
  readonly links: Cell[][] = [];
  readonly kinds = new Map<string, number>();
  private readonly seen = new Set<string>();
  /** A cap was reached: the rest was not written. */
  cut = false;

  node(id: string, kind: string, label: string, page: number | null = null, body = ''): string {
    if (this.nodes.has(id)) return id;
    // A coverage node is always written: it says what was cut.
    if (kind !== 'coverage' && this.nodes.size >= LINK_NODES_ROWS_MAX) {
      this.cut = true;
      return id;
    }
    this.nodes.set(id, [id, kind, label, page, body.slice(0, NODE_TEXT_MAX) || null]);
    return id;
  }

  /** The text of a node, set once a rule knows it (a class's facts). */
  setText(id: string, body: string): void {
    const n = this.nodes.get(id);
    if (n) n[4] = body.slice(0, NODE_TEXT_MAX);
  }

  link(from: string, to: string, kind: string, page: number | null, source: string): void {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return;
    const key = `${from}\u0000${to}\u0000${kind}\u0000${page ?? ''}`;
    if (this.seen.has(key)) return;
    if (this.links.length >= LINKS_ROWS_MAX) {
      this.cut = true;
      return;
    }
    this.seen.add(key);
    this.links.push([from, to, kind, page, source]);
    this.kinds.set(kind, (this.kinds.get(kind) ?? 0) + 1);
  }

  /** The links of one kind so far. */
  count(kind: string): number {
    return this.kinds.get(kind) ?? 0;
  }
}

/** A column that holds codes, by its header: a header with the word code,
 *  or a part, stock or catalogue number. */
const CODE_HEADER = /code|\b(?:part|stock|catalog(?:ue)?|item)\s*(?:no\b|number|#)/i;
/** A code in a code column: 4 to 20 letters, digits or hyphens, a digit in
 *  it, and 5 digits or more when it is digits alone. A short token there
 *  is a note number (`NR4`) or a rating (`3000`) a misread row put in the
 *  column. */
const CODE_IN_COLUMN = /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,19}$/;
/** A code a column of no code header holds: digits alone, 6 to 12 of them,
 *  or letters and 4 digits or more, 5 to 14 in all. Stricter, as the
 *  column is known only by its cells. */
const CODE_BY_VALUE = /^(?:\d{6,12}|(?=(?:[A-Z]*\d){4})(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,14})$/;
/** A column of no code header is a code column when this share of its
 *  cells, and at least CODE_COLUMN_MIN of them, are one code each. */
const CODE_COLUMN_SHARE = 0.6;
const CODE_COLUMN_MIN = 3;

const codeTokens = (cell: string): string[] =>
  cell
    .toUpperCase()
    .split(/[\s|,;]+/)
    .map((t) => t.replace(/[*.]+$/, ''))
    .filter((t) => t !== '');

const isCodeInColumn = (t: string) => CODE_IN_COLUMN.test(t) && (/[A-Z]/.test(t) || t.length >= 5);

/** The words of a text that may be a code: split on all but letters,
 *  digits and hyphens. */
const wordsOf = (s: string): string[] =>
  s
    .toUpperCase()
    .split(/[^A-Z0-9-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length >= 3);

/** The code columns of a table: by header, else by their cells. */
export function codeColumnsOf(table: LinkTable): { column: number; byHeader: boolean }[] {
  const out: { column: number; byHeader: boolean }[] = [];
  const columns = table.rows[0]?.columns ?? [];
  columns.forEach((name, c) => {
    if (name === 'Page') return;
    if (CODE_HEADER.test(name)) {
      out.push({ column: c, byHeader: true });
      return;
    }
    let filled = 0;
    let codes = 0;
    for (const r of table.rows) {
      const cell = r.cells[c] ?? '';
      if (cell === '') continue;
      filled += 1;
      const t = codeTokens(cell);
      if (t.length === 1 && CODE_BY_VALUE.test(t[0]!)) codes += 1;
    }
    if (codes >= CODE_COLUMN_MIN && codes >= filled * CODE_COLUMN_SHARE) {
      out.push({ column: c, byHeader: false });
    }
  });
  return out;
}

/** A cell of prose: three words or more of letters alone. A note that a
 *  misread row put in a code column is no list of codes. */
const isProse = (tokens: readonly string[]) =>
  tokens.filter((t) => /^[A-Z]{3,}$/.test(t)).length >= 3;

/** The codes of one cell of a code column: none from prose; in a column
 *  known by its header, each token of a code's shape; in one known by its
 *  cells, only the strict shape that made it a code column. */
export function codesOfCell(cell: string, byHeader: boolean): string[] {
  const tokens = codeTokens(cell);
  if (isProse(tokens)) return [];
  return tokens.filter((t) => (byHeader ? isCodeInColumn(t) : CODE_BY_VALUE.test(t)));
}

/** Tags and line numbers of a text by the tag grammar (../../../pdf-tags.ts),
 *  with no site profile. */
function tagsOfText(s: string): { kind: 'tag' | 'line'; value: string }[] {
  const out: { kind: 'tag' | 'line'; value: string }[] = [];
  for (const token of tokensOf(s)) {
    const read = tokenItems(token);
    if (!read) continue;
    for (const item of read.items) {
      if (read.kind === 'line') {
        const l = parseLineNumber(item);
        if (l) out.push({ kind: 'line', value: l.line });
      } else if (read.kind === 'instrument') {
        const t = parseInstrumentTag(item);
        if (t) out.push({ kind: 'tag', value: t.tag });
      } else {
        const e = parseEquipmentTag(item);
        if (e) out.push({ kind: 'tag', value: e.tag });
      }
    }
  }
  return out;
}

/** A column of tags or line numbers, by its header. */
const TAG_HEADER = /\btags?\b|\bline\s*(?:no\b|number)/i;

const SEE_TABLE = /\b(?:see|refer to|per|in)\s+table\s+(\d+(?:\.\d+)*[A-Z]?)\b/gi;
const SEE_NOTE = /\b(?:see|refer to|per)\s+(?:general\s+)?notes?\s+(\d+(?:\.\d+)*)\b/gi;
const SEE_PAGE = /\b(?:see|on|refer to)\s+page\s+(\d{1,6})\b/gi;
const NOTE_LINE = /^\s*NOTE\s+(\d+(?:\.\d+)*)\s*[:.)-]?\s+\S/i;

/** The generic rules: they fill `set`, and give each row its codes. */
export function genericLinks(input: LinkInput, set: LinkSet): void {
  const file = set.node(ids.file(), 'file', 'the file');
  const pageIds = new Set<number>();
  for (const p of input.pages) {
    set.node(ids.page(p.page), 'page', `page ${p.page}`, p.page);
    pageIds.add(p.page);
    set.link(file, ids.page(p.page), 'HAS_PAGE', p.page, sourceOf('page', 'Pages', p.page));
  }

  // Tables, their pages and rows.
  for (const t of input.tables) {
    set.node(t.id, 'table', t.title || t.tab, t.first, t.tab);
    if (t.first !== null && t.last !== null) {
      for (let p = t.first; p <= t.last && p - t.first < 1_000; p += 1) {
        if (pageIds.has(p))
          set.link(t.id, ids.page(p), 'TABLE_ON_PAGE', p, sourceOf('tables index', 'Tables'));
      }
    }
    for (const r of t.rows) {
      set.node(r.id, 'row', `row ${r.n} of ${t.tab}`, r.page, r.text);
      set.link(t.id, r.id, 'HAS_ROW', r.page, sourceOf('row', t.tab, r.n));
    }
  }

  // Codes: the cells of code columns, then every word of a row or a page
  // that is one of those codes.
  const vocab = new Set<string>();
  for (const t of input.tables) {
    const columns = codeColumnsOf(t);
    for (const r of t.rows) {
      for (const { column, byHeader } of columns) {
        for (const code of codesOfCell(r.cells[column] ?? '', byHeader)) {
          vocab.add(code);
          r.codes.add(code);
        }
      }
    }
  }
  for (const t of input.tables) {
    for (const r of t.rows) {
      for (const w of wordsOf(r.text)) if (vocab.has(w)) r.codes.add(w);
      for (const code of r.codes) {
        set.node(ids.code(code), 'code', code);
        set.link(r.id, ids.code(code), 'NAMES_CODE', r.page, sourceOf('code', t.tab, r.n));
      }
    }
  }
  for (const p of input.pages) {
    if (p.text === '') continue;
    const seen = new Set<string>();
    for (const w of wordsOf(p.text)) if (vocab.has(w)) seen.add(w);
    for (const code of seen) {
      set.node(ids.code(code), 'code', code);
      set.link(
        ids.page(p.page),
        ids.code(code),
        'NAMES_CODE',
        p.page,
        sourceOf('code', p.from, p.page),
      );
    }
  }

  // Tags and line numbers: the Reader's own (a drawing), and the tag
  // grammar on the cells of a tag or line column of a table (a book). Not
  // on a book's running text: there the grammar reads grades and codes
  // (WP-11, A-98) as tags.
  for (const t of input.tags) {
    if (t.page === null || !pageIds.has(t.page)) continue;
    set.node(ids.tag(t.tag), 'tag', t.tag, null, t.type);
    set.link(ids.page(t.page), ids.tag(t.tag), 'NAMES_TAG', t.page, sourceOf('tag', 'Tags', t.n));
  }
  for (const l of input.lines) {
    if (l.page === null || !pageIds.has(l.page)) continue;
    set.node(ids.line(l.line), 'line', l.line);
    set.link(
      ids.page(l.page),
      ids.line(l.line),
      'NAMES_LINE',
      l.page,
      sourceOf('line', 'Lines', l.n),
    );
  }
  const tagLinks = (from: string, s: string, page: number | null, source: string) => {
    for (const t of tagsOfText(s)) {
      const id = t.kind === 'line' ? ids.line(t.value) : ids.tag(t.value);
      set.node(id, t.kind, t.value);
      set.link(from, id, t.kind === 'line' ? 'NAMES_LINE' : 'NAMES_TAG', page, source);
    }
  };
  for (const t of input.tables) {
    const columns = (t.rows[0]?.columns ?? [])
      .map((name, c) => (TAG_HEADER.test(name) ? c : -1))
      .filter((c) => c >= 0);
    if (columns.length === 0) continue;
    for (const r of t.rows) {
      const cells = columns.map((c) => r.cells[c] ?? '').join(' ');
      tagLinks(r.id, cells, r.page, sourceOf('tag grammar', t.tab, r.n));
    }
  }

  // References: to a table, a note or a page that is there.
  const tableByNumber = new Map<string, string>();
  for (const t of input.tables) {
    for (const name of [t.title, t.tab]) {
      const m = /^\s*table\s+(\d+(?:\.\d+)*[A-Z]?)\b/i.exec(name);
      if (m && !tableByNumber.has(m[1]!.toUpperCase()))
        tableByNumber.set(m[1]!.toUpperCase(), t.id);
    }
  }
  const notes = new Map<string, number>();
  for (const p of input.pages) {
    for (const line of p.text.split('\n')) {
      const m = NOTE_LINE.exec(line);
      if (m && !notes.has(m[1]!)) notes.set(m[1]!, p.page);
    }
  }
  for (const [n, page] of notes) set.node(ids.note(n), 'note', `note ${n}`, page);
  for (const p of input.pages) {
    if (p.text === '') continue;
    const from = ids.page(p.page);
    const source = sourceOf('reference', p.from, p.page);
    for (const m of p.text.matchAll(SEE_TABLE)) {
      const to = tableByNumber.get(m[1]!.toUpperCase());
      if (to) set.link(from, to, 'REFERS_TO', p.page, source);
    }
    for (const m of p.text.matchAll(SEE_NOTE)) {
      if (notes.has(m[1]!)) set.link(from, ids.note(m[1]!), 'REFERS_TO', p.page, source);
    }
    for (const m of p.text.matchAll(SEE_PAGE)) {
      const to = Number(m[1]);
      if (to !== p.page && pageIds.has(to))
        set.link(from, ids.page(to), 'REFERS_TO', p.page, source);
    }
  }
}

/** A list of pages as runs: `1-3, 7, 9-12`, cut at PAGE_LIST_MAX. */
export function pageList(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  const out = parts.join(', ');
  return out.length > PAGE_LIST_MAX ? `${out.slice(0, PAGE_LIST_MAX)} ...` : out;
}

/** A coverage node: one short line, and its detail. */
export function coverage(set: LinkSet, what: string, label: string, detail = ''): void {
  set.node(ids.coverage(what), 'coverage', label, null, detail);
}

/** The coverage of the generic rules, after every rule ran. */
function genericCoverage(input: LinkInput, set: LinkSet): void {
  const noText = input.pages.filter((p) => p.text.trim() === '').map((p) => p.page);
  if (noText.length > 0) {
    coverage(
      set,
      'pages-no-text',
      `${noText.length} of ${input.pages.length} pages have no text (unread scans or blank pages); they gave no links from text.`,
      pageList(noText),
    );
  }
  const cut = input.pages.filter((p) => p.cut).map((p) => p.page);
  if (cut.length > 0) {
    coverage(
      set,
      'pages-text-cut',
      `${cut.length} page texts were cut at ${AFTER_CELL_MAX_CHARS.toLocaleString('en')} characters before the read; their end gave no links.`,
      pageList(cut),
    );
  }
  if (input.tablesNotRead.length > 0) {
    coverage(
      set,
      'tables-not-read',
      `${input.tablesNotRead.length} tables named in Tables were not read (the input was full); their rows gave no links.`,
      input.tablesNotRead.slice(0, 50).join(' | '),
    );
  }
}

/** The closing coverage: what the two tabs are, and the count of each kind. */
function closingCoverage(set: LinkSet): void {
  coverage(
    set,
    'links',
    `Links holds ${set.links.length.toLocaleString('en')} links (from_id, to_id, kind, page, source); Link nodes holds the things they name (id, kind, label, page, text). Derived from this file's tabs by fixed patterns; source names the rule, the tab and the row.`,
  );
  for (const [kind, n] of [...set.kinds].sort((a, b) => a[0].localeCompare(b[0]))) {
    coverage(set, `kind:${kind}`, `${kind}: ${n.toLocaleString('en')} links`);
  }
  if (set.cut) {
    coverage(
      set,
      'cut',
      `A cap was reached (${LINKS_ROWS_MAX.toLocaleString('en')} links or ${LINK_NODES_ROWS_MAX.toLocaleString('en')} nodes): the rest was not written.`,
    );
  }
}

const COLUMNS_LINKS: ParsedSheet['columns'] = [
  { name: 'from_id', type: 'select' },
  { name: 'to_id', type: 'select' },
  { name: 'kind', type: 'select' },
  { name: 'page', type: 'number' },
  { name: 'source', type: 'text' },
];
const COLUMNS_NODES: ParsedSheet['columns'] = [
  { name: 'id', type: 'select' },
  { name: 'kind', type: 'select' },
  { name: 'label', type: 'text' },
  { name: 'page', type: 'number' },
  { name: 'text', type: 'text' },
];

/** One rule pack: a kind of document (./packs.ts). */
export type LinkPack = {
  id: string;
  /** What it reads, for its coverage line. */
  name: string;
  /** A cheap count of its own patterns; the pack is on when `on` says so. */
  count(input: LinkInput): number;
  on(count: number, input: LinkInput): boolean;
  /** Its links, after the generic rules (rows carry their codes). */
  build(input: LinkInput, set: LinkSet): void;
};

/**
 * The two sheets of a file's tabs: the generic rules, each pack that
 * switches itself on, and the coverage. No tab when the file has no page
 * and no table: there is nothing to link.
 */
export function buildLinks(
  input: LinkInput,
  packs: readonly LinkPack[],
): { sheets: ParsedSheet[]; warnings: string[]; packsOn: string[] } {
  if (input.pages.length === 0 && input.tables.length === 0) {
    return { sheets: [], warnings: [], packsOn: [] };
  }
  const set = new LinkSet();
  genericLinks(input, set);
  const packsOn: string[] = [];
  for (const pack of packs) {
    const n = pack.count(input);
    const on = pack.on(n, input);
    coverage(
      set,
      `pack:${pack.id}`,
      `Rule pack ${pack.name}: ${on ? 'on' : 'off'} (${n.toLocaleString('en')} of its patterns found).`,
    );
    if (!on) continue;
    packsOn.push(pack.id);
    pack.build(input, set);
  }
  genericCoverage(input, set);
  closingCoverage(set);
  const warnings = set.cut
    ? [
        `Links reached a cap (${LINKS_ROWS_MAX.toLocaleString('en')} links or ${LINK_NODES_ROWS_MAX.toLocaleString('en')} nodes); the rest was not written.`,
      ]
    : [];
  return {
    sheets: [
      { name: LINKS_TAB, columns: COLUMNS_LINKS, rows: set.links },
      { name: LINK_NODES_TAB, columns: COLUMNS_NODES, rows: [...set.nodes.values()] },
    ],
    warnings,
    packsOn,
  };
}
