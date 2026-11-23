/**
 * The rule pack of a piping material specification: a book of class sheets,
 * one or more pages a piping class (a code such as `K2` or `Q3X`), each with
 * a cover (service, rating, base material, temperature limits, corrosion
 * allowance) and the items of the class in tables under group headers
 * (`****BOLTING****`), with addendums that change a class. Pure: the
 * input of ./links.ts in, links out. Data (the patterns below) and small
 * functions, so another pack (drawings) is one more file beside it.
 *
 * It switches itself on by a count of its own pattern: the pages whose top
 * lines carry a class header. On when they are CLASS_PAGES_MIN or more and
 * at least CLASS_PAGES_SHARE of the pages with text.
 *
 * Kinds: CLASS_PAGE, CLASS_TABLE, CLASS_ROW, CLASS_CODE, CLASS_MATERIAL,
 * NAMES_MATERIAL, IN_GROUP, HAS_RATING, HAS_BASE_MATERIAL; for an addendum
 * page ADDENDUM_PAGE, CHANGES_CLASS, HAS_CHANGE, ADDENDUM_ROW,
 * ADDENDUM_CODE, ADDENDUM_MATERIAL. A row on an addendum page links to the
 * addendum, never to the class: an addendum may only change a class.
 */
import {
  coverage,
  pageList,
  sourceOf,
  type LinkInput,
  type LinkPack,
  type LinkPage,
  type LinkRow,
  type LinkSet,
} from './links';

/** The pack is on with this many class header pages, and this share of
 *  the pages with text. */
const CLASS_PAGES_MIN = 3;
const CLASS_PAGES_SHARE = 0.05;
/** The top lines of a page a header is looked for in. */
const HEAD_LINES = 25;
/** The top lines of a page `ADDENDUM` is looked for in. */
const ADDENDUM_LINES = 14;

/** A class code: 1 to 8 letters and digits, with a letter and a digit. */
const CLASS_CODE = /^(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{1,8}$/;
/** A class header with its code on the same line: `Piping Specification
 *  No: K2G`, `PipingSpecificationNo: K2G`, `LINE CLASS: K2U`, `PIPE CLASS
 *  K1`. */
const HEADER_SAME =
  /\b(?:PIPING|PIPE|LINE)\s*(?:SPECIFICATION|SPEC|CLASS)\s*(?:NO\.?|NUMBER)?\s*[:;.]?\s*([A-Za-z0-9]{1,8})\b/i;
/** A class header alone on its line; the code is on a line next to it. */
const HEADER_ALONE =
  /^\W*(?:PIPING|PIPE|LINE)\s*(?:SPECIFICATION|SPEC|CLASS)\s*(?:NO\.?|NUMBER)?\s*[:;.]?\s*$/i;
/** A title box whose last label is CLASS (an older sheet): the code ends a
 *  line below it, after the corrosion allowance (`0.125 0 3 Q1R1`). */
const BOX_LABELS = /\bREV\b.*\bCLASS\s*$/i;
const BOX_VALUES = /\b\d?\.\d{2,4}\s+(?:\S+\s+){0,4}([A-Za-z0-9]{2,6})\s*$/;
/** An addendum page: ADDENDUM opens a top line, or `ADDENDUM TO` /
 *  `ADDENDUM Page`. `Addendums` in a sentence is none. */
const ADDENDUM_LINE = /^\W*ADDENDUM\b|\bADDENDUM\s+(?:TO|PAGE|NO)\b/i;
/** The code before `Revision` on an addendum's top line (`Q2X Revision: 0`). */
const ADDENDUM_CLASS = /\b([A-Z0-9]{1,8})\s+Revision\b/;
/** The revision of an addendum, read before `SUPERSEDES` (the old one is
 *  after it). */
const REVISION = /\bRevision\s*(?:No\.?)?\s*[:;]?\s*([A-Z0-9]{1,3})\b/i;
const SUPERSEDES = /\bSUPERSEDES\b/i;
/** One numbered change of an addendum: `1.7 Revise ...`. */
const CHANGE =
  /^\s*(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\s+((?:Add|Revise|Delete|Replace|Change|Remove|Use)\b.{0,160})/gim;
/** A column of an item's name (`ITEM NAME`), never its code. */
const ITEM_NAME = /\bITEM\s*NAME\b/i;
/** A group header row: `****BOLTING****`. */
const GROUP = /\*{3,}\s*([A-Z][A-Z &/,.-]*?)\s*\*{3,}/;

/** The cover's facts. */
const RATINGS = '150|300|400|600|800|900|1500|2500|3000|6000';
/** `0.063 600 RF`, `0.063 Class 600 RF`: corrosion allowance, rating, face. */
const COVER_ROW = new RegExp(
  `\\b(\\d?\\.\\d{2,4})\\s+(?:CLASS\\s+)?(${RATINGS})#?\\s*(RF|FF|RTJ)\\b`,
  'i',
);
/** `300# RF`, `300 #RFSF` (a raised face, smooth finish). */
const RATING_FACE = new RegExp(`\\b(${RATINGS})\\s*#\\s*(RTJ|RF|FF)`);
/** An older sheet's line: the base material, then the rating and face
 *  (`FULLY KILLED STEEL 150 #RFSF`, `321 STAINLESS STEEL 600 #RF`). The
 *  material ends in a material word, so an item line (`WN TAP PAIR 600#RF`)
 *  is none. */
const MATERIAL_RATING = new RegExp(
  `^\\s*([A-Za-z0-9][A-Za-z0-9 /&-]{1,40}?(?:STEEL|STL|SS|ALLOY|IRON|MOLY|CHROME|NICKEL|BRONZE|BRASS|COPPER|LINED))\\s+(?:${RATINGS})\\s*#\\s*(?:RTJ|RF|FF)`,
  'im',
);
/** The base material after the design code: `ASME B31.3 KILLED CARBON
 *  STEEL 0.125 300 RF`. */
const MATERIAL_ROW = /\bB31\.\d+\s+([A-Za-z0-9][A-Za-z0-9 /&-]*?[A-Za-z])\s+\d?\.\d{2,4}\s/;
/** `Material: Killed Carbon Steel Paint: ...`: the words up to the next
 *  label (the last word before the next colon), or to the end of the line. */
const MATERIAL_LABEL = /\bMaterial\s*:\s*([^\n]*)/i;
function labelValue(rest: string): string {
  const colon = rest.indexOf(':');
  if (colon < 0) return rest;
  return rest.slice(0, colon).replace(/\s*\S+\s*$/, '');
}
const SERVICE = /\bSERVICE(?:\s+DESCRIPTION)?\s*:\s*(.*)$/im;
/** `TEMPERATURE LIMITS (°F): -20 / 400`: the label, the low limit, a unit
 *  beside it, the high limit. */
const TEMPS =
  /\bTEMP(?:ERATURE)?\.?\s*LIMITS?([^:\n]*):\s*(-?\s?\d+)\s*(°\s*[FC])?\s*(?:\/|TO)\s*(-?\s?\d+)/i;
/** A unit of temperature: `°F`, `° F`, `DEG F`, `DEG. F`, the same with C.
 *  A bare F or C is none. */
const UNIT = String.raw`(?:° ?|\bDEG\.? )([FC])(?![A-Z])`;
const TEMP_UNIT = new RegExp(UNIT, 'gi');
/** A unit right after the high limit. */
const TEMP_UNIT_AFTER = new RegExp(`^[ \\t]*${UNIT}`, 'i');
/** An older sheet's limits, in the head block of each of its pages: a line
 *  of `Temperature Range -20 /650` and nothing more (a unit may follow). The
 *  groups are those of TEMPS. */
const RANGE = new RegExp(
  String.raw`^[ \t]*TEMP(?:ERATURE)?\.?[ \t]*RANGE([ \t]*(?:\([^)\n]*\))?)[ \t]*:?[ \t]*(-?[ \t]?\d+)[ \t]*(°[ \t]*[FC])?[ \t]*(?:\/|TO)[ \t]*(-?[ \t]?\d+)(?=[ \t]*(?:${UNIT})?[ \t]*$)`,
  'gim',
);

/** A line is boilerplate when it is on this share of the pages with text
 *  (a sheet's frame: the company, the place). */
const BOILERPLATE_SHARE = 0.25;

/** A class code as read, upper case. In a code that has a digit, OCR's
 *  lower case l is a 1 (`Q1Rl`); in one with no digit it is no code. */
function classCodeOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const code = (/\d/.test(raw) ? raw.replace(/l/g, '1') : raw).toUpperCase();
  return CLASS_CODE.test(code) ? code : null;
}

const linesOf = (p: LinkPage) => p.text.split('\n').map((l) => l.trim());

/** Whether a page is an addendum. */
export function isAddendum(p: LinkPage): boolean {
  return linesOf(p)
    .slice(0, ADDENDUM_LINES)
    .some((l) => ADDENDUM_LINE.test(l));
}

/** The class of a page by its top lines, and the rule that read it:
 *  `header` (the code on the header's line or next to it), `addendum`, or
 *  `title box` (an older sheet; the weakest). */
export function classOfPage(p: LinkPage): { code: string; rule: string } | null {
  const lines = linesOf(p).slice(0, HEAD_LINES);
  for (const l of lines) {
    const code = classCodeOf(HEADER_SAME.exec(l)?.[1]);
    if (code) return { code, rule: 'header' };
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!HEADER_ALONE.test(lines[i]!)) continue;
    for (const j of [i - 1, i + 1, i - 2, i + 2]) {
      const near = (lines[j] ?? '').replace(/^[I|l]\s+/, '');
      const code = /^[A-Za-z0-9]{1,8}$/.test(near) ? classCodeOf(near) : null;
      if (code) return { code, rule: 'header' };
    }
  }
  if (isAddendum(p)) {
    const head = lines.slice(0, ADDENDUM_LINES);
    for (const l of head) {
      const code = classCodeOf(ADDENDUM_CLASS.exec(l)?.[1]);
      if (code) return { code, rule: 'addendum' };
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!BOX_LABELS.test(lines[i]!)) continue;
    for (const l of lines.slice(i + 1, i + 4)) {
      const code = classCodeOf(BOX_VALUES.exec(l)?.[1]);
      if (code) return { code, rule: 'title box' };
    }
  }
  return null;
}

/** The revision of an addendum page: the one before `SUPERSEDES`. */
export function addendumRevision(p: LinkPage): string {
  const head = linesOf(p).slice(0, ADDENDUM_LINES).join('\n');
  const current = head.split(SUPERSEDES)[0]!;
  return REVISION.exec(current)?.[1]?.toUpperCase() ?? '?';
}

/**
 * The materials of a text, by specification number only: `A193`, `A106`,
 * `A105`, `API5L`. The grade stays in the row's text, where full text and
 * LIKE find it. A number right after `#` is a maker's model number
 * (`#A417KX`), no material. Text with no spaces (`FLGA105RF`) gets a space
 * before the number; OCR's `Al05` is A105.
 */
export function materialsOf(raw: string): Set<string> {
  const out = new Set<string>();
  const s = raw
    .toUpperCase()
    .replace(/\bA[LI](\d{2})\b/g, 'A1$1')
    .replace(/(?<=[A-Z/-])(?=[AB]\d{3}(?!\d))/g, ' ');
  if (/\bAPI[- ]?5L/.test(s)) out.add('API5L');
  for (const m of s.matchAll(/(?<!#)\b(?:ASTM\s*)?([AB])\s?(\d{3})(?![\d.])/g)) {
    if (Number(m[2]) >= 100) out.add(`${m[1]}${m[2]}`);
  }
  return out;
}

/** The lines on BOILERPLATE_SHARE of the pages with text, longest first. */
function boilerplateOf(pages: readonly LinkPage[]): string[] {
  const withText = pages.filter((p) => p.text !== '');
  const count = new Map<string, number>();
  for (const p of withText) {
    for (const l of new Set(linesOf(p).slice(0, HEAD_LINES))) {
      if (l.length >= 6) count.set(l, (count.get(l) ?? 0) + 1);
    }
  }
  const min = Math.max(3, withText.length * BOILERPLATE_SHARE);
  return [...count]
    .filter(([, n]) => n >= min)
    .map(([l]) => l)
    .sort((a, b) => b.length - a.length);
}

type Facts = {
  service?: string;
  rating?: string;
  face?: string;
  material?: string;
  corr?: string;
  temp?: string;
};

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The limits of a TEMPS or RANGE match, with the unit the line states: in
 *  the label, beside the low limit, or right after the high limit. None
 *  when it states none, or two. */
function tempOf(t: string, m: RegExpExecArray): string {
  const units = new Set(
    [
      ...[...m[1]!.matchAll(TEMP_UNIT)].map((u) => u[1]),
      m[3]?.slice(-1),
      TEMP_UNIT_AFTER.exec(t.slice(m.index + m[0].length))?.[1],
    ]
      .filter((u) => u !== undefined)
      .map((u) => u.toUpperCase()),
  );
  const unit = units.size === 1 ? ` °${[...units][0]}` : '';
  return `${m[2]!.replace(/\s/g, '')}/${m[4]!.replace(/\s/g, '')}${unit}`;
}

/** The limits each `Temperature Range` line of a page states. */
export function rangesOf(p: LinkPage): string[] {
  return [...p.text.matchAll(RANGE)].map((m) => tempOf(p.text, m));
}

/** The facts of a class's cover page. */
export function coverFacts(p: LinkPage, boilerplate: readonly string[]): Facts {
  const t = p.text;
  const f: Facts = {};
  let m = COVER_ROW.exec(t);
  if (m) [f.corr, f.rating, f.face] = [m[1]!, m[2]!, m[3]!.toUpperCase()];
  else if ((m = RATING_FACE.exec(t))) [f.rating, f.face] = [m[1]!, m[2]!];
  const label = MATERIAL_LABEL.exec(t)?.[1];
  const mat =
    MATERIAL_ROW.exec(t)?.[1] ??
    (label !== undefined ? labelValue(label) : undefined) ??
    MATERIAL_RATING.exec(t)?.[1];
  if (mat && /^[A-Za-z0-9][A-Za-z0-9 /&-]*$/.test(clean(mat)) && /[A-Za-z]{2}/.test(mat)) {
    f.material = clean(mat).toUpperCase();
  }
  m = TEMPS.exec(t);
  if (m) f.temp = tempOf(t, m);
  m = SERVICE.exec(t);
  if (m) {
    const strip = (line: string) => {
      const frame = boilerplate.find((b) => line.startsWith(b));
      return clean(frame ? line.slice(frame.length) : line);
    };
    let service = strip(m[1]!);
    if (service.length < 3) {
      const after = t
        .slice(m.index + m[0].length)
        .split('\n')
        .find((l) => l.trim() !== '');
      service = after ? strip(after.trim()) : '';
    }
    if (service.length >= 3) f.service = service.slice(0, 160);
  }
  return f;
}

/** The pages of each class: a header page, a page between two pages of
 *  one class, and no class read only once by the weakest rule. */
export function classesOf(pages: readonly LinkPage[]): Map<number, { code: string; rule: string }> {
  const out = new Map<number, { code: string; rule: string }>();
  for (const p of pages) {
    if (p.text === '') continue;
    const c = classOfPage(p);
    if (c) out.set(p.page, c);
  }
  const count = new Map<string, number>();
  for (const c of out.values()) count.set(c.code, (count.get(c.code) ?? 0) + 1);
  for (const [page, c] of out) {
    if (c.rule === 'title box' && count.get(c.code) === 1) out.delete(page);
  }
  for (const p of pages) {
    if (out.has(p.page)) continue;
    const a = out.get(p.page - 1);
    const b = out.get(p.page + 1);
    if (a && b && a.code === b.code) out.set(p.page, { code: a.code, rule: 'between' });
  }
  return out;
}

const classId = (c: string) => `class:${c}`;
const matId = (m: string) => `mat:${m}`;

function build(input: LinkInput, set: LinkSet): void {
  const classes = classesOf(input.pages);
  const addendum = new Map<number, string>();

  // Classes and their pages; addendums and what they change.
  for (const p of input.pages) {
    const c = classes.get(p.page);
    if (c) {
      set.node(classId(c.code), 'class', c.code);
      set.link(
        classId(c.code),
        `page:${p.page}`,
        'CLASS_PAGE',
        p.page,
        sourceOf(`class ${c.rule}`, p.from, p.page),
      );
    }
    if (p.text === '' || !isAddendum(p)) continue;
    const cls = c?.code ?? 'general';
    const rev = addendumRevision(p);
    const id = set.node(
      `addendum:${cls}:${rev}`,
      'addendum',
      `addendum revision ${rev} to ${cls}`,
      p.page,
    );
    addendum.set(p.page, id);
    const source = sourceOf('addendum', p.from, p.page);
    set.link(id, `page:${p.page}`, 'ADDENDUM_PAGE', p.page, source);
    if (c) set.link(id, classId(c.code), 'CHANGES_CLASS', p.page, source);
    for (const m of p.text.matchAll(CHANGE)) {
      const change = set.node(
        `change:${cls}:${rev}:${m[1]}`,
        'addendum change',
        clean(m[2]!).slice(0, 160),
        p.page,
      );
      set.link(id, change, 'HAS_CHANGE', p.page, source);
    }
  }

  // The facts of each class: each fact from the first of its pages (no
  // addendum) that states it, in page order (the cover, as a rule). A class
  // with no limits line takes its limits from its Range lines, when they all
  // state one and the same.
  const boilerplate = boilerplateOf(input.pages);
  const factsOf = new Map<string, { facts: Facts; pages: Partial<Record<keyof Facts, number>> }>();
  const ranges = new Map<string, Set<string>>();
  for (const p of input.pages) {
    const c = classes.get(p.page);
    if (!c || addendum.has(p.page) || p.text === '') continue;
    const entry = factsOf.get(c.code) ?? { facts: {}, pages: {} };
    factsOf.set(c.code, entry);
    for (const [k, v] of Object.entries(coverFacts(p, boilerplate)) as [keyof Facts, string][]) {
      if (entry.facts[k] !== undefined) continue;
      entry.facts[k] = v;
      entry.pages[k] = p.page;
    }
    const seen = ranges.get(c.code) ?? new Set<string>();
    ranges.set(c.code, seen);
    for (const r of rangesOf(p)) seen.add(r);
  }
  const count = { rating: 0, material: 0, service: 0, temp: 0, unit: 0 };
  for (const [code, { facts: f, pages }] of factsOf) {
    const range = ranges.get(code)!;
    if (f.temp === undefined && range.size === 1) f.temp = [...range][0]!;
    if (Object.keys(f).length === 0) continue;
    set.setText(classId(code), JSON.stringify(f));
    if (f.rating) {
      count.rating += 1;
      const page = pages.rating ?? null;
      set.link(
        classId(code),
        set.node(`rating:${f.rating}`, 'rating', `class ${f.rating}`),
        'HAS_RATING',
        page,
        sourceOf('class cover', 'Pages', page ?? undefined),
      );
    }
    if (f.material) {
      count.material += 1;
      const page = pages.material ?? null;
      set.link(
        classId(code),
        set.node(`basemat:${f.material}`, 'base material', f.material),
        'HAS_BASE_MATERIAL',
        page,
        sourceOf('class cover', 'Pages', page ?? undefined),
      );
    }
    if (f.service) count.service += 1;
    if (f.temp) count.temp += 1;
    if (f.temp?.includes('°')) count.unit += 1;
  }

  // Tables and rows: to their class, or to the addendum of their page. A
  // table whose title, less its numbered lead words and its page mark, is
  // exactly a group name of the book starts in that group: the Reader made
  // the group's header line the title.
  const names = new Set<string>();
  for (const t of input.tables) {
    for (const r of t.rows) {
      const own = r.page !== null && classes.has(r.page) && !addendum.has(r.page);
      const g = own ? groupOf(r) : null;
      if (g) names.add(g);
    }
  }
  const group = new Map<string, string>();
  for (const t of input.tables) {
    const first = t.first !== null ? classes.get(t.first) : undefined;
    let fromTitle = false;
    if (first && t.first !== null && !addendum.has(t.first)) {
      set.link(classId(first.code), t.id, 'CLASS_TABLE', t.first, sourceOf('class of page', t.tab));
      const title = titleGroupOf(t.title);
      fromTitle = names.has(title);
      if (fromTitle) group.set(first.code, title);
    }
    for (const r of t.rows) rowLinks(r, classes, addendum, group, set);
    // A group from a title holds for its own table only.
    if (fromTitle && !t.rows.some((r) => groupOf(r))) group.delete(first!.code);
  }

  // What the pack could not read.
  const noClass = input.pages
    .filter((p) => p.text !== '' && !classes.has(p.page))
    .map((p) => p.page);
  const codes = new Set([...classes.values()].map((c) => c.code));
  coverage(
    set,
    'pack:piping-spec:classes',
    `${codes.size} classes on ${classes.size} pages; ${noClass.length} pages with text have no class (notes, key sheets, or a header the rules could not read).`,
    pageList(noClass),
  );
  coverage(
    set,
    'pack:piping-spec:covers',
    `Class facts of ${codes.size} classes: a rating for ${count.rating}, a base material for ${count.material}, a service for ${count.service}, temperature limits for ${count.temp} (from a limits or range line; ${count.unit} with the unit their line states). A class with none read has no facts.`,
  );
  if (addendum.size > 0) {
    coverage(
      set,
      'pack:piping-spec:addendums',
      `${addendum.size} addendum pages; their rows link to the addendum, not to the class.`,
      pageList([...addendum.keys()]),
    );
  }
}

/** The group a header row opens (`****BOLTING****`), or null. */
function groupOf(r: LinkRow): string | null {
  const m = GROUP.exec(r.text.replace(/\s*\|\s*/g, ' '));
  return m ? clean(m[1]!).replace(/\s*CONTINUED$/, '') : null;
}

/** A table title as a group name: upper case, less its lead words with a
 *  digit (`412 K2`) and its page mark (`p40`). */
function titleGroupOf(title: string): string {
  const words = clean(title.toUpperCase().replace(/\s+P\d+(?:-\d+)?$/, '')).split(' ');
  while (words.length > 0 && /\d/.test(words[0]!)) words.shift();
  return words.join(' ');
}

/** One row: its class or addendum, its codes, materials and group. */
function rowLinks(
  r: LinkRow,
  classes: ReadonlyMap<number, { code: string }>,
  addendum: ReadonlyMap<number, string>,
  group: Map<string, string>,
  set: LinkSet,
): void {
  const c = r.page !== null ? classes.get(r.page) : undefined;
  const add = r.page !== null ? addendum.get(r.page) : undefined;
  const source = sourceOf('class of page', r.tab, r.n);
  const owner = add ?? (c ? classId(c.code) : undefined);
  const kind = (what: string) => (add ? `ADDENDUM_${what}` : `CLASS_${what}`);
  if (owner) set.link(owner, r.id, kind('ROW'), r.page, source);
  if (owner)
    for (const code of r.codes) set.link(owner, `code:${code}`, kind('CODE'), r.page, source);
  const desc = r.columns.findIndex((col) => /DESC/i.test(col));
  const mats = materialsOf(desc >= 0 && r.cells[desc] ? r.cells[desc]! : r.text);
  for (const m of mats) {
    set.node(matId(m), 'material', m);
    set.link(r.id, matId(m), 'NAMES_MATERIAL', r.page, sourceOf('material', r.tab, r.n));
    if (owner) set.link(owner, matId(m), kind('MATERIAL'), r.page, source);
  }
  // A group runs on over the pages of a class, never into an addendum.
  if (!c || add) return;
  const header = groupOf(r);
  if (header) {
    group.set(c.code, header);
    return;
  }
  // An item row: it has a code, or an item's name (a row of a special
  // item may have no code).
  const g = group.get(c.code);
  const named = r.columns.some((col, i) => ITEM_NAME.test(col) && (r.cells[i] ?? '') !== '');
  if (g && (r.codes.size > 0 || named)) {
    set.link(
      r.id,
      set.node(`group:${g}`, 'item group', g),
      'IN_GROUP',
      r.page,
      sourceOf('group header', r.tab, r.n),
    );
  }
}

export const PIPING_SPEC_PACK: LinkPack = {
  id: 'piping-spec',
  name: 'piping material specification',
  count: (input) =>
    input.pages.filter((p) => p.text !== '' && classOfPage(p)?.rule === 'header').length,
  on: (count, input) =>
    count >= CLASS_PAGES_MIN &&
    count >= input.pages.filter((p) => p.text !== '').length * CLASS_PAGES_SHARE,
  build,
};
