/**
 * The `pid` data contract and its checks. Tags, line numbers and set points
 * are the user's: the template never invents one, and the checks never
 * "correct" one. They only say when one does not read (tag letters in the
 * wrong order, a line number outside the site's format).
 */
import {
  bool,
  checkKeys,
  done,
  isObj,
  list,
  newIssues,
  number,
  objects,
  oneOf,
  str,
  suggest,
  type Checked,
  type Issues,
  type Obj,
} from '../../runtime/validate.ts';
import { isColour, isTrustColour, STYLE_EDITIONS, type StyleEdition } from '../../runtime/style.ts';
import {
  FOLLOWING_LETTERS,
  parseLineNumber,
  resolveProfile,
  type CustomSymbol,
  type ResolvedProfile,
  type SiteProfile,
} from './profile.ts';
import {
  checkListOf,
  checkOf,
  checksSummaryOf,
  provenanceOf,
  type PidCheck,
  type PidChecksSummary,
  type PidProvenance,
} from './check.ts';

export const PID_VERSION = 1;

export const EQUIPMENT_TYPES = [
  'vertical-vessel',
  'horizontal-drum',
  'column',
  'tank',
  'centrifugal-pump',
  'pd-pump',
  'compressor',
  'shell-tube-exchanger',
  'exchanger',
  'air-cooler',
  'filter',
] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const VALVE_TYPES = [
  'gate',
  'globe',
  'ball',
  'butterfly',
  'check',
  'three-way',
  'control',
  'relief',
  'reducer',
  'blind',
  'orifice',
] as const;
export type ValveType = (typeof VALVE_TYPES)[number];

export const PORTS = ['top', 'bottom', 'left', 'right'] as const;
export type Port = (typeof PORTS)[number];

export const SIGNAL_TYPES = [
  'electric',
  'pneumatic',
  'data',
  'capillary',
  'hydraulic',
  'connection',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const LOCATIONS = ['field', 'control-room', 'local-panel', 'behind-panel'] as const;
export const DISPLAYS = ['discrete', 'shared', 'computer', 'plc', 'interlock'] as const;

/** How the live canvas shows the drawing (never the export): `zoom`
 *  forces the zoom and pan controls on or off; absent, they show only when
 *  the drawing does not fit the frame at a readable size. */
export type DrawingView = { zoom?: boolean };

export type Equipment = {
  id: string;
  type: EquipmentType;
  service?: string;
  focal: boolean;
  /** Layout hints, the agent's lever when the automatic layout crowds:
   *  the column (0 is the leftmost process column) and the row (`base`
   *  stands on the vessel baseline, `below` sits under it with the pumps). */
  column?: number;
  row?: 'base' | 'below';
};
/** A jump to another page of a drawing set (pages), and the element to
 *  show there. `ref` is the page reference the drawing prints ("see page
 *  3: <title>"), filled in by the set's check (set.ts). */
export type PageLink = { page: string; focus?: string; ref?: string };
export type OffPage = {
  id: string;
  direction: 'in' | 'out';
  sheet: string;
  text?: string;
  /** Inside a set only: the page this connector continues on. */
  link?: PageLink;
  /** The image check of the guess this end draws (./check.ts). */
  check?: PidCheck;
};
/** A "more here" marker beside a line: what the page leaves to another
 *  ("+7 DEADLEGS"), with the page that holds it inside a set. */
export type More = { text: string; link?: PageLink };
export type InlineItem = {
  type: ValveType;
  tag?: string;
  actuator: 'diaphragm' | 'piston' | 'motor';
  fail?: 'FO' | 'FC' | 'FL';
  closed: boolean;
  focal: boolean;
  /** The image check of a valve type read from a block name (./check.ts). */
  check?: PidCheck;
};
export const LINE_ENDS = ['open', 'cap'] as const;
export const TOWARD = ['up', 'down', 'left', 'right'] as const;

/** Why a drawing's own colour (a circuit's, a service's) is refused: it is
 *  one the image check's marks wear (style.ts isTrustColour). */
const TRUST_COLOUR_ERROR = (path: string, colour: string) =>
  `${path}: '${colour}' is a colour the drawing keeps for the image check (GUESS, CHECKED BY IMAGE, IMAGE: NO, FROM IMAGE), so a line would wear a check no image gave it. Pick another (series-1..series-5 or another #rrggbb).`;
export type Toward = (typeof TOWARD)[number];

export type Line = {
  id: string;
  number?: string;
  /** Equipment, an off-page connector, or a tee (a branch off another line). */
  from: string;
  /** Equipment, an off-page connector, a tee, or an instrument tag (the
   *  bubble sits at the end of the branch). Absent when the line stops
   *  (`end`). */
  to?: string;
  /** The line stops short: an open end (a stub) or a cap. */
  end?: (typeof LINE_ENDS)[number];
  /** A dead leg: drawn with a cap (unless it ends elsewhere) and a DL tag. */
  deadleg?: true;
  /** Which way a line that stops (or ends at an instrument) leaves. */
  toward?: Toward;
  fromPort?: Port;
  toPort?: Port;
  service?: string;
  weight: 'main' | 'secondary';
  inline: InlineItem[];
  focal: boolean;
  /** A short note drawn beside the line, such as an honesty mark
   *  ("INFERRED JOIN (GUESS)"). */
  note?: string;
  /** A "more here" marker beside the line. */
  more?: More;
  /** The image checks of the inferred joins the line's note counts, one
   *  per join (./check.ts). */
  checks?: PidCheck[];
};
export type Instrument = {
  tag: string;
  letters: string;
  loop: string;
  /** What it measures or sits on: an equipment id, or a line id. */
  on?: { kind: 'equipment' | 'line'; id: string };
  location: (typeof LOCATIONS)[number];
  display: (typeof DISPLAYS)[number];
  setpoint?: string;
  focal: boolean;
};
export type Signal = { from: string; to: string; type: SignalType };
/** A junction on a line: branches start or end at it. */
export type Tee = {
  id: string;
  /** The parent line's id. */
  on: string;
  /** Which end of the parent the tee keeps to; by default it sits where its
   *  branch leaves most directly. */
  near?: 'from' | 'to';
  /** Where along the parent the tee sits, 0 at its `from` end to 1 at its
   *  `to` end (a traced drawing's order of branches); wins over `near`. */
  at?: number;
};
export type Circuit = {
  id: string;
  label: string;
  lines: string[];
  equipment: string[];
  colour?: string;
};

export type PidData = {
  title: string;
  /** The drawing style edition (style.ts): 1 classic, 2 the colour set. */
  style: StyleEdition;
  view?: DrawingView;
  description?: string;
  sheet?: { number?: string; revision?: string };
  profile: ResolvedProfile;
  showTitle: boolean;
  legend: boolean;
  /** The legend's names for the two line weights, when the sheet's lines
   *  are not process and utility lines (a traced circuit's main line and
   *  its branches). Absent: "Process line" and "Utility line". */
  legendNames?: { main?: string; secondary?: string };
  equipment: Equipment[];
  offpage: OffPage[];
  lines: Line[];
  tees: Tee[];
  instruments: Instrument[];
  signals: Signal[];
  circuits: Circuit[];
  /** The image check counts of the drawing's guesses (./check.ts). */
  checks?: PidChecksSummary;
  /** The guesses circuit_trace drew, sealed (./check.ts). */
  provenance?: PidProvenance;
};

/** Hard limits (errors) and the guide's complexity budget (warnings). */
export const PID_LIMITS = {
  equipment: 30,
  lines: 60,
  instruments: 60,
  offpage: 20,
  tees: 30,
  signals: 60,
  circuits: 12,
  /** Valves and reducers drawn on one line. */
  inline: 6,
  /** The longest text a field takes, in characters. */
  text: {
    title: 80,
    description: 300,
    /** An off-page connector's text. */
    connector: 40,
    /** A line's "+N" marker. */
    marker: 32,
    /** A line's number. */
    lineNumber: 40,
    /** A line's note. */
    note: 32,
    /** A circuit's label. */
    circuitLabel: 40,
  },
  budget: {
    equipment: 8,
    instruments: 16,
    valves: 20,
    loops: 5,
    lines: 12,
    lineTypes: 4,
    accents: 2,
  },
};

const TOP_KEYS = [
  'template',
  'version',
  'title',
  'description',
  'sheet',
  'profile',
  'showTitle',
  'legend',
  'legendNames',
  'equipment',
  'offpage',
  'lines',
  'tees',
  'instruments',
  'signals',
  'circuits',
  'checks',
  'provenance',
  'style',
  'view',
];
const PROFILE_KEYS = [
  'name',
  'lineNumber',
  'colourByService',
  'serviceColours',
  'instrumentFirstLetters',
  'symbols',
  'customSymbols',
];

export const TAG_PATTERN = /^([A-Z]{1,6})-?([0-9]{1,6}[A-Z]?)$/;

/** Do the letters of an instrument tag read? First a variable, then
 *  functions (ISA-5.1). Returns a problem, or null. */
export function tagLettersProblem(
  letters: string,
  firstLetters: Record<string, string>,
): string | null {
  const first = letters[0]!;
  if (!(first in firstLetters)) {
    return `the first letter '${first}' is not a measured variable (${Object.keys(firstLetters).join(' ')})`;
  }
  for (const ch of letters.slice(1)) {
    if (!FOLLOWING_LETTERS.has(ch)) return `'${ch}' is not a function letter`;
  }
  if (letters.length === 1)
    return 'a tag needs a function letter after the variable (for example LT, not L)';
  return null;
}

function checkProfile(raw: unknown, issues: Issues): SiteProfile | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    issues.errors.push('profile: must be an object (the site profile).');
    return undefined;
  }
  checkKeys(raw, PROFILE_KEYS, 'profile', issues);
  const out: SiteProfile = {};
  const name = str(raw, 'name', 'profile', issues, { max: 60 });
  if (name) out.name = name;
  if (raw.lineNumber !== undefined) {
    if (!isObj(raw.lineNumber))
      issues.errors.push('profile.lineNumber: must be an object { pattern, example?, enforce? }.');
    else {
      checkKeys(raw.lineNumber, ['pattern', 'example', 'enforce'], 'profile.lineNumber', issues);
      const pattern = str(raw.lineNumber, 'pattern', 'profile.lineNumber', issues, {
        required: true,
        max: 300,
      });
      const example = str(raw.lineNumber, 'example', 'profile.lineNumber', issues, { max: 60 });
      const enforce = oneOf(
        raw.lineNumber,
        'enforce',
        ['error', 'warning'] as const,
        'profile.lineNumber',
        issues,
      );
      if (pattern) {
        try {
          const re = new RegExp(pattern);
          if (example && !re.test(example))
            issues.errors.push(
              `profile.lineNumber.example: '${example}' does not match the pattern.`,
            );
          out.lineNumber = {
            pattern,
            ...(example ? { example } : {}),
            ...(enforce ? { enforce } : {}),
          };
        } catch {
          issues.errors.push('profile.lineNumber.pattern: not a valid regular expression.');
        }
      }
    }
  }
  const cbs = bool(raw, 'colourByService', 'profile', issues);
  if (cbs !== undefined) out.colourByService = cbs;
  if (raw.serviceColours !== undefined) {
    if (!isObj(raw.serviceColours))
      issues.errors.push('profile.serviceColours: must map service codes to colours.');
    else {
      out.serviceColours = {};
      for (const [k, v] of Object.entries(raw.serviceColours)) {
        if (typeof v !== 'string' || !isColour(v)) {
          issues.errors.push(
            `profile.serviceColours.${k}: '${String(v)}' is not a colour (series-1..series-5, ink, muted, or #rrggbb).`,
          );
        } else if (isTrustColour(v)) {
          issues.errors.push(TRUST_COLOUR_ERROR(`profile.serviceColours.${k}`, v));
        } else out.serviceColours[k] = v;
      }
    }
  }
  if (raw.instrumentFirstLetters !== undefined) {
    if (!isObj(raw.instrumentFirstLetters))
      issues.errors.push('profile.instrumentFirstLetters: must map a letter to its meaning.');
    else {
      out.instrumentFirstLetters = {};
      for (const [k, v] of Object.entries(raw.instrumentFirstLetters)) {
        if (!/^[A-Z]$/.test(k) || typeof v !== 'string')
          issues.errors.push(
            `profile.instrumentFirstLetters.${k}: one capital letter mapped to its meaning.`,
          );
        else out.instrumentFirstLetters[k] = v;
      }
    }
  }
  if (raw.symbols !== undefined) {
    if (!isObj(raw.symbols)) issues.errors.push('profile.symbols: must be an object.');
    else {
      checkKeys(
        raw.symbols,
        ['normallyClosed', 'checkValve', 'corners', 'crossing', 'deadleg'],
        'profile.symbols',
        issues,
      );
      const s = raw.symbols;
      const nc = oneOf(s, 'normallyClosed', ['text', 'filled'] as const, 'profile.symbols', issues);
      const cv = oneOf(s, 'checkValve', ['filled', 'arrow'] as const, 'profile.symbols', issues);
      const co = oneOf(s, 'corners', ['square', 'round'] as const, 'profile.symbols', issues);
      const cr = oneOf(s, 'crossing', ['hop', 'gap'] as const, 'profile.symbols', issues);
      const dl = oneOf(s, 'deadleg', ['cap', 'dashed'] as const, 'profile.symbols', issues);
      out.symbols = {
        ...(nc ? { normallyClosed: nc } : {}),
        ...(cv ? { checkValve: cv } : {}),
        ...(co ? { corners: co } : {}),
        ...(cr ? { crossing: cr } : {}),
        ...(dl ? { deadleg: dl } : {}),
      };
    }
  }
  if (raw.customSymbols !== undefined) {
    if (!isObj(raw.customSymbols))
      issues.errors.push('profile.customSymbols: must map a type name to { w, h, paths }.');
    else {
      out.customSymbols = {};
      for (const [k, v] of Object.entries(raw.customSymbols)) {
        const p = `profile.customSymbols.${k}`;
        if (
          !(EQUIPMENT_TYPES as readonly string[]).includes(k) &&
          !(VALVE_TYPES as readonly string[]).includes(k)
        ) {
          issues.errors.push(
            `${p}: '${k}' is not an equipment or valve type${suggest(k, [...EQUIPMENT_TYPES, ...VALVE_TYPES]) ? ` (did you mean '${suggest(k, [...EQUIPMENT_TYPES, ...VALVE_TYPES])}'?)` : ''}.`,
          );
          continue;
        }
        if (!isObj(v)) {
          issues.errors.push(`${p}: must be { w, h, paths }.`);
          continue;
        }
        checkKeys(v, ['w', 'h', 'paths'], p, issues);
        const w = number(v, 'w', p, issues, { min: 8, max: 320 });
        const h = number(v, 'h', p, issues, { min: 8, max: 320 });
        const paths: CustomSymbol['paths'] = [];
        for (const [pp, po] of objects(
          list(v, 'paths', p, issues, { required: true, max: 24 }),
          `${p}.paths`,
          issues,
        )) {
          checkKeys(po, ['d', 'fill'], pp, issues);
          // Path data only: commands, numbers, spaces and commas. No markup
          // can ride in on a site profile.
          const d = str(po, 'd', pp, issues, {
            required: true,
            max: 2000,
            pattern: /^[MmLlHhVvCcSsQqTtAaZz0-9 ,.\-e]+$/,
            patternText: 'SVG path data (commands and numbers only)',
          });
          const fill = oneOf(po, 'fill', ['none', 'paper', 'ink'] as const, pp, issues);
          if (d) paths.push({ d, ...(fill ? { fill } : {}) });
        }
        if (w && h && paths.length) out.customSymbols[k] = { w, h, paths };
      }
    }
  }
  return out;
}

/** A page id in a drawing set: a short tag. */
export const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

/** A link read while checking one page of a set, for the set to resolve. */
export type LinkSite = { path: string; link: PageLink };
/** `links` present: the data is one page of a set (set.ts), and every
 *  `link` it holds is collected there. Absent: a single drawing, where a
 *  link has nowhere to go. */
export type PidCheckOptions = { links?: LinkSite[] };

function linkOf(o: Obj, p: string, issues: Issues, opts: PidCheckOptions): PageLink | undefined {
  const page = str(o, 'link', p, issues, {
    max: 32,
    pattern: PAGE_ID,
    patternText: 'a page id (letters, digits, - . _)',
  });
  const focus = str(o, 'focus', p, issues, { max: 40 });
  if (focus && !page)
    issues.errors.push(`${p}.focus: only with 'link' (the page to show '${focus}' on).`);
  if (!page) return undefined;
  if (!opts.links) {
    issues.errors.push(
      `${p}.link: '${page}' is another page, and this drawing has no pages. Put the drawings in a set ({ title, pages: [{ id, title, data }] }) or drop 'link'.`,
    );
    return undefined;
  }
  const link: PageLink = { page, ...(focus ? { focus } : {}) };
  opts.links.push({ path: `${p}.link`, link });
  return link;
}

/** The drawing-wide view fields every pid input may carry, a set's too:
 *  the style edition and the live canvas's view. */
export function drawingFields(d: Obj, issues: Issues): { style: StyleEdition; view?: DrawingView } {
  let style: StyleEdition = 1;
  if (d.style !== undefined) {
    if (!(STYLE_EDITIONS as readonly unknown[]).includes(d.style))
      issues.errors.push(
        `style: ${JSON.stringify(d.style)} is not a style edition (${STYLE_EDITIONS.join(' or ')}; 2 is the colour set).`,
      );
    else style = d.style as StyleEdition;
  }
  let view: DrawingView | undefined;
  if (d.view !== undefined) {
    if (!isObj(d.view)) issues.errors.push('view: must be { zoom? }.');
    else {
      checkKeys(d.view, ['zoom'], 'view', issues);
      const zoom = bool(d.view, 'zoom', 'view', issues);
      view = zoom === undefined ? {} : { zoom };
    }
  }
  return { style, ...(view ? { view } : {}) };
}

export function validatePid(input: unknown, opts: PidCheckOptions = {}): Checked<PidData> {
  const issues = newIssues();
  if (!isObj(input)) return { ok: false, errors: ['data: must be a JSON object.'], warnings: [] };
  const d = input as Obj;
  checkKeys(d, TOP_KEYS, '', issues);
  if (d.template !== undefined && d.template !== 'pid') {
    issues.errors.push(
      `template: this is the 'pid' template, the data says '${String(d.template)}'.`,
    );
  }
  const title = str(d, 'title', '', issues, { required: true, max: PID_LIMITS.text.title }) ?? '';
  const description = str(d, 'description', '', issues, {
    max: PID_LIMITS.text.description,
  });
  if (!description)
    issues.warnings.push(
      'description: add one sentence on what the sheet shows (screen readers read it).',
    );
  const showTitle = bool(d, 'showTitle', '', issues) ?? true;
  const legend = bool(d, 'legend', '', issues) ?? true;
  const checks = checksSummaryOf(d, '', issues);
  const provenance = provenanceOf(d, '', issues);
  const drawing = drawingFields(d, issues);
  let legendNames: PidData['legendNames'];
  if (d.legendNames !== undefined) {
    if (!isObj(d.legendNames))
      issues.errors.push('legendNames: must be { main?, secondary? }, the legend text per weight.');
    else {
      checkKeys(d.legendNames, ['main', 'secondary'], 'legendNames', issues);
      const main = str(d.legendNames, 'main', 'legendNames', issues, { max: 32 });
      const secondary = str(d.legendNames, 'secondary', 'legendNames', issues, { max: 32 });
      legendNames = { ...(main ? { main } : {}), ...(secondary ? { secondary } : {}) };
    }
  }
  let sheet: PidData['sheet'];
  if (d.sheet !== undefined) {
    if (!isObj(d.sheet)) issues.errors.push('sheet: must be { number?, revision? }.');
    else {
      checkKeys(d.sheet, ['number', 'revision'], 'sheet', issues);
      const number = str(d.sheet, 'number', 'sheet', issues, { max: 40 });
      const revision = str(d.sheet, 'revision', 'sheet', issues, { max: 8 });
      sheet = { ...(number ? { number } : {}), ...(revision ? { revision } : {}) };
    }
  }
  const rawProfile = checkProfile(d.profile, issues);
  const profile = resolveProfile(rawProfile);

  // Every tag on the sheet shares one namespace: equipment, connectors,
  // inline tags and instruments.
  const tags = new Map<string, string>();
  const claim = (tag: string, path: string) => {
    const prev = tags.get(tag);
    if (prev) issues.errors.push(`${path}: tag '${tag}' is already used by ${prev}.`);
    else tags.set(tag, path);
  };
  const tagRule = {
    required: true,
    max: 32,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_./-]*$/,
    patternText: 'a tag (letters, digits, - . / _)',
  };

  const equipment: Equipment[] = [];
  for (const [p, e] of objects(
    list(d, 'equipment', '', issues, { required: true, max: PID_LIMITS.equipment }),
    'equipment',
    issues,
  )) {
    checkKeys(e, ['id', 'type', 'service', 'focal', 'column', 'row'], p, issues);
    const column = number(e, 'column', p, issues, { min: 0, max: 20 });
    if (column !== undefined && !Number.isInteger(column))
      issues.errors.push(`${p}.column: a whole number (0 is the leftmost column).`);
    const row = oneOf(e, 'row', ['base', 'below'] as const, p, issues);
    const id = str(e, 'id', p, issues, tagRule);
    const type = oneOf(e, 'type', EQUIPMENT_TYPES, p, issues);
    if (e.type === undefined)
      issues.errors.push(`${p}.type: required, one of ${EQUIPMENT_TYPES.join(', ')}.`);
    const service = str(e, 'service', p, issues, { max: 40 });
    const focal = bool(e, 'focal', p, issues) ?? false;
    if (id) claim(id, p);
    if (id && type) {
      equipment.push({
        id,
        type,
        focal,
        ...(service ? { service } : {}),
        ...(column !== undefined ? { column } : {}),
        ...(row ? { row } : {}),
      });
    }
  }

  const offpage: OffPage[] = [];
  for (const [p, o] of objects(
    list(d, 'offpage', '', issues, { max: PID_LIMITS.offpage }),
    'offpage',
    issues,
  )) {
    checkKeys(o, ['id', 'direction', 'sheet', 'text', 'link', 'focus', 'check'], p, issues);
    const id = str(o, 'id', p, issues, tagRule);
    const direction = oneOf(o, 'direction', ['in', 'out'] as const, p, issues);
    if (o.direction === undefined)
      issues.errors.push(`${p}.direction: required, 'in' (comes from another sheet) or 'out'.`);
    const sheetNo = str(o, 'sheet', p, issues, { required: true, max: 12 });
    const text = str(o, 'text', p, issues, { max: PID_LIMITS.text.connector });
    const link = linkOf(o, p, issues, opts);
    const check = checkOf(o, p, issues);
    if (id) claim(id, p);
    if (id && direction && sheetNo)
      offpage.push({
        id,
        direction,
        sheet: sheetNo,
        ...(text ? { text } : {}),
        ...(link ? { link } : {}),
        ...(check ? { check } : {}),
      });
  }
  // Tees: junctions on a line, where branches start or end. Read before the
  // lines (a line may start at one) and checked against them after.
  const teeRaw: { p: string; id: string; on?: string; near?: 'from' | 'to'; at?: number }[] = [];
  for (const [p, t] of objects(
    list(d, 'tees', '', issues, { max: PID_LIMITS.tees }),
    'tees',
    issues,
  )) {
    checkKeys(t, ['id', 'on', 'near', 'at'], p, issues);
    const id = str(t, 'id', p, issues, tagRule);
    const on = str(t, 'on', p, issues, { required: true, max: 40 });
    const near = oneOf(t, 'near', ['from', 'to'] as const, p, issues);
    const at = number(t, 'at', p, issues, { min: 0, max: 1 });
    if (id) {
      claim(id, p);
      teeRaw.push({
        p,
        id,
        ...(on ? { on } : {}),
        ...(near ? { near } : {}),
        ...(at !== undefined ? { at } : {}),
      });
    }
  }
  const teeIds = new Set(teeRaw.map((t) => t.id));
  // A branch may end at a bubble; the instruments are checked further down.
  const instrumentTags = new Set(
    (Array.isArray(d.instruments) ? d.instruments : [])
      .filter(isObj)
      .map((i) => i.tag)
      .filter((t): t is string => typeof t === 'string'),
  );
  const ends = new Set([...equipment.map((e) => e.id), ...offpage.map((o) => o.id)]);
  const endNoun = teeIds.size
    ? 'equipment, off-page connector or tee'
    : 'equipment or off-page connector';
  const endHint = (v: string, more: string[] = []) => {
    const s = suggest(v, [...ends, ...teeIds, ...more]);
    return s ? ` (did you mean '${s}'?)` : '';
  };

  const lines: Line[] = [];
  const lineIds = new Map<string, string>();
  const inlineTags = new Map<string, string>(); // tag -> line id
  objects(list(d, 'lines', '', issues, { max: PID_LIMITS.lines }), 'lines', issues).forEach(
    ([p, l], i) => {
      checkKeys(
        l,
        [
          'id',
          'number',
          'from',
          'to',
          'fromPort',
          'toPort',
          'service',
          'weight',
          'inline',
          'focal',
          'end',
          'deadleg',
          'toward',
          'note',
          'more',
          'checks',
        ],
        p,
        issues,
      );
      const number = str(l, 'number', p, issues, { max: PID_LIMITS.text.lineNumber });
      const id = str(l, 'id', p, issues, { max: 40 }) ?? number ?? `L${i + 1}`;
      if (lineIds.has(id) && l.id !== undefined)
        issues.errors.push(`${p}.id: line id '${id}' is already used by ${lineIds.get(id)}.`);
      // A line that stops short (`end`, or a dead leg with no `to`) has no `to`.
      const stops = l.end !== undefined || (l.deadleg === true && l.to === undefined);
      const from = str(l, 'from', p, issues, { required: true });
      const to = str(l, 'to', p, issues, { required: !stops });
      const fromOk = !!from && (ends.has(from) || teeIds.has(from));
      const toKind = !to
        ? undefined
        : ends.has(to)
          ? 'node'
          : teeIds.has(to)
            ? 'tee'
            : instrumentTags.has(to)
              ? 'instrument'
              : undefined;
      if (from && !fromOk)
        issues.errors.push(
          `${p}.from: no ${endNoun} '${from}'${endHint(from)}.${instrumentTags.has(from) ? ' A line cannot start at an instrument: start it at a tee or equipment and end it at the bubble.' : ''}`,
        );
      if (to && !toKind)
        issues.errors.push(`${p}.to: no ${endNoun} '${to}'${endHint(to, [...instrumentTags])}.`);
      if (from && to && from === to)
        issues.errors.push(`${p}: a line from '${from}' back to itself is not drawn.`);
      const end = oneOf(l, 'end', LINE_ENDS, p, issues);
      const deadleg = bool(l, 'deadleg', p, issues) ?? false;
      const toward = oneOf(l, 'toward', TOWARD, p, issues);
      if (to && end)
        issues.errors.push(
          `${p}.end: a line with 'end' stops short and has no 'to'; drop 'to' for a stub or a cap, or drop 'end' to run it to '${to}'.`,
        );
      const stub = !to || toKind === 'instrument';
      if (toward && !stub)
        issues.errors.push(
          `${p}.toward: only for a line that stops ('end') or ends at an instrument; a line to '${to}' is routed (set fromPort or toPort instead).`,
        );
      const fromPort = oneOf(l, 'fromPort', PORTS, p, issues);
      const toPort = oneOf(l, 'toPort', PORTS, p, issues);
      if (fromPort && from && teeIds.has(from))
        issues.errors.push(
          `${p}.fromPort: '${from}' is a tee; a branch leaves its parent line square, so drop fromPort (use toward on a stub).`,
        );
      if (toPort && (stub || toKind === 'tee'))
        issues.errors.push(
          `${p}.toPort: only for a line that ends at equipment or a connector; drop it${stub ? ' (use toward to pick the way the line leaves)' : ''}.`,
        );
      let service = str(l, 'service', p, issues, {
        max: 6,
        pattern: /^[A-Z]{1,6}$/,
        patternText: 'a service code in capitals (P, ST, CW)',
      });
      const weight = oneOf(l, 'weight', ['main', 'secondary'] as const, p, issues) ?? 'main';
      const note = str(l, 'note', p, issues, { max: PID_LIMITS.text.note });
      let more: More | undefined;
      if (l.more !== undefined) {
        const mp = `${p}.more`;
        if (!isObj(l.more))
          issues.errors.push(
            `${mp}: must be { text, link?, focus? }, e.g. { "text": "+7 DEADLEGS" }.`,
          );
        else {
          checkKeys(l.more, ['text', 'link', 'focus'], mp, issues);
          const text = str(l.more, 'text', mp, issues, {
            required: true,
            max: PID_LIMITS.text.marker,
          });
          const link = linkOf(l.more, mp, issues, opts);
          if (text) more = { text, ...(link ? { link } : {}) };
        }
      }
      const focal = bool(l, 'focal', p, issues) ?? false;
      const checks = checkListOf(l, p, issues);
      if (number) {
        const parts = parseLineNumber(profile, number);
        if (!parts) {
          const msg = `${p}.number: '${number}' does not match the site's line number format${profile.lineExample ? ` (for example ${profile.lineExample})` : ''}. Use the user's line number exactly; never make one up.`;
          (profile.enforce === 'error' ? issues.errors : issues.warnings).push(msg);
        } else if (!service && parts.service) service = parts.service;
      }
      const inline: InlineItem[] = [];
      for (const [ip, it] of objects(
        list(l, 'inline', p, issues, { max: PID_LIMITS.inline }),
        `${p}.inline`,
        issues,
      )) {
        checkKeys(it, ['type', 'tag', 'actuator', 'fail', 'closed', 'focal', 'check'], ip, issues);
        const type = oneOf(it, 'type', VALVE_TYPES, ip, issues);
        if (it.type === undefined)
          issues.errors.push(`${ip}.type: required, one of ${VALVE_TYPES.join(', ')}.`);
        const tag = str(it, 'tag', ip, issues, { ...tagRule, required: false });
        const actuator =
          oneOf(it, 'actuator', ['diaphragm', 'piston', 'motor'] as const, ip, issues) ??
          'diaphragm';
        const fail = oneOf(it, 'fail', ['FO', 'FC', 'FL'] as const, ip, issues);
        const closed = bool(it, 'closed', ip, issues) ?? false;
        const ifocal = bool(it, 'focal', ip, issues) ?? false;
        const icheck = checkOf(it, ip, issues);
        if (type === 'control' && !tag)
          issues.warnings.push(
            `${ip}: a control valve usually carries its tag (for example LV-101).`,
          );
        if (fail && type !== 'control')
          issues.warnings.push(`${ip}.fail: a failure position belongs on a control valve.`);
        if (tag) {
          claim(tag, ip);
          inlineTags.set(tag, id);
        }
        if (type)
          inline.push({
            type,
            actuator,
            closed,
            focal: ifocal,
            ...(tag ? { tag } : {}),
            ...(fail ? { fail } : {}),
            ...(icheck ? { check: icheck } : {}),
          });
      }
      if (fromOk && (to ? toKind : stops || end) && from !== to) {
        lineIds.set(id, p);
        const endAs = to ? undefined : (end ?? 'cap');
        lines.push({
          id,
          from: from!,
          weight,
          inline,
          focal,
          ...(to ? { to } : {}),
          ...(endAs ? { end: endAs } : {}),
          ...(deadleg ? { deadleg: true as const } : {}),
          ...(toward ? { toward } : {}),
          ...(number ? { number } : {}),
          ...(fromPort ? { fromPort } : {}),
          ...(toPort ? { toPort } : {}),
          ...(service ? { service } : {}),
          ...(note ? { note } : {}),
          ...(more ? { more } : {}),
          ...(checks ? { checks } : {}),
        });
      }
    },
  );

  const instruments: Instrument[] = [];
  for (const [p, it] of objects(
    list(d, 'instruments', '', issues, { max: PID_LIMITS.instruments }),
    'instruments',
    issues,
  )) {
    checkKeys(it, ['tag', 'on', 'location', 'display', 'setpoint', 'focal'], p, issues);
    const tag = str(it, 'tag', p, issues, { required: true, max: 16 });
    if (!tag) continue;
    const m = TAG_PATTERN.exec(tag);
    if (!m) {
      issues.errors.push(
        `${p}.tag: '${tag}' is not an instrument tag (letters, then the loop number: LT-101, FIC-2001).`,
      );
      continue;
    }
    const letters = m[1]!;
    const problem = tagLettersProblem(letters, profile.firstLetters);
    if (problem)
      issues.errors.push(
        `${p}.tag: '${tag}' does not read: ${problem}. ISA-5.1 order is variable, then functions (FIC, not CIF).`,
      );
    claim(tag, p);
    let on: Instrument['on'];
    const onRaw = str(it, 'on', p, issues);
    if (onRaw) {
      if (ends.has(onRaw) && equipment.some((e) => e.id === onRaw))
        on = { kind: 'equipment', id: onRaw };
      else if (lineIds.has(onRaw)) on = { kind: 'line', id: onRaw };
      else {
        const s = suggest(onRaw, [...equipment.map((e) => e.id), ...lineIds.keys()]);
        issues.errors.push(
          `${p}.on: '${onRaw}' is neither an equipment id nor a line id or number${s ? ` (did you mean '${s}'?)` : ''}.`,
        );
      }
    }
    const location = oneOf(it, 'location', LOCATIONS, p, issues) ?? 'field';
    const display = oneOf(it, 'display', DISPLAYS, p, issues) ?? 'discrete';
    const setpoint = str(it, 'setpoint', p, issues, { max: 24 });
    const focal = bool(it, 'focal', p, issues) ?? false;
    instruments.push({
      tag,
      letters,
      loop: m[2]!,
      location,
      display,
      focal,
      ...(on ? { on } : {}),
      ...(setpoint ? { setpoint } : {}),
    });
  }

  // A branch that ends at a bubble: the bubble sits at the end of the
  // branch, so it is not also `on` something, and it ends one line only.
  const endsAtBubble = new Map<string, string>(); // tag -> line path
  for (const l of lines) {
    if (!l.to || !instrumentTags.has(l.to) || ends.has(l.to) || teeIds.has(l.to)) continue;
    const lp = lineIds.get(l.id)!;
    const inst = instruments.find((x) => x.tag === l.to);
    if (!inst) continue; // its own error is above
    if (inst.on)
      issues.errors.push(
        `${lp}.to: instrument '${inst.tag}' also has 'on' ('${inst.on.id}'). A bubble at the end of a branch is drawn there; drop its 'on', or end the line elsewhere.`,
      );
    if (endsAtBubble.has(inst.tag))
      issues.errors.push(
        `${lp}.to: instrument '${inst.tag}' already ends ${endsAtBubble.get(inst.tag)}; a bubble ends one line. Tee off that line instead.`,
      );
    else endsAtBubble.set(inst.tag, lp);
  }

  // The tees, now that the lines are known: each sits on a line, and no
  // branch may (through other tees) sit on itself.
  const tees: Tee[] = [];
  const teeParent = new Map<string, string>();
  for (const t of teeRaw) {
    if (!t.on) continue;
    if (!lineIds.has(t.on)) {
      const sg = suggest(t.on, [...lineIds.keys()]);
      issues.errors.push(
        `${t.p}.on: no line '${t.on}'${sg ? ` (did you mean '${sg}'?)` : ''}. A tee sits on a line: give that line's id, or its number exactly.`,
      );
      continue;
    }
    teeParent.set(t.id, t.on);
    tees.push({
      id: t.id,
      on: t.on,
      ...(t.near ? { near: t.near } : {}),
      ...(t.at !== undefined ? { at: t.at } : {}),
    });
  }
  const lineById = new Map(lines.map((l) => [l.id, l]));
  // Every tee a line hangs from, directly or through its parent's tees.
  const ancestors = (lineId: string, seen = new Set<string>()): Set<string> => {
    const l = lineById.get(lineId);
    if (!l || seen.has(lineId)) return new Set();
    seen.add(lineId);
    const out = new Set<string>();
    for (const e of [l.from, l.to]) {
      if (!e || !teeParent.has(e)) continue;
      out.add(e);
      for (const a of ancestors(teeParent.get(e)!, seen)) out.add(a);
    }
    return out;
  };
  for (const t of tees) {
    const tp = teeRaw.find((x) => x.id === t.id)!.p;
    if (ancestors(t.on).has(t.id))
      issues.errors.push(
        `${tp}.on: tee '${t.id}' sits on line '${t.on}', which itself starts or ends at '${t.id}' (directly or through other tees). Put the tee on the line its branch leaves.`,
      );
    if (!lines.some((l) => l.from === t.id || l.to === t.id))
      issues.warnings.push(
        `${tp}: tee '${t.id}' has no branch (no line starts or ends at it), so it is not drawn.`,
      );
  }
  // A line that names a tee whose own entry failed is dropped with it.
  const goodTee = (e?: string) => !e || !teeIds.has(e) || teeParent.has(e);
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k]!;
    if (!goodTee(l.from) || !goodTee(l.to)) lines.splice(k, 1);
  }

  const signalEnds = new Set([...instruments.map((i) => i.tag), ...inlineTags.keys()]);
  const signals: Signal[] = [];
  for (const [p, s] of objects(
    list(d, 'signals', '', issues, { max: PID_LIMITS.signals }),
    'signals',
    issues,
  )) {
    checkKeys(s, ['from', 'to', 'type'], p, issues);
    const from = str(s, 'from', p, issues, { required: true });
    const to = str(s, 'to', p, issues, { required: true });
    const type = oneOf(s, 'type', SIGNAL_TYPES, p, issues) ?? 'electric';
    for (const [k, v] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (v && !signalEnds.has(v)) {
        const sg = suggest(v, [...signalEnds]);
        issues.errors.push(
          `${p}.${k}: no instrument or tagged valve '${v}'${sg ? ` (did you mean '${sg}'?)` : ''}.`,
        );
      }
    }
    if (from && to && signalEnds.has(from) && signalEnds.has(to)) signals.push({ from, to, type });
  }

  const circuits: Circuit[] = [];
  const lineOwner = new Map<string, string>();
  for (const [p, c] of objects(
    list(d, 'circuits', '', issues, { max: PID_LIMITS.circuits }),
    'circuits',
    issues,
  )) {
    checkKeys(c, ['id', 'label', 'lines', 'equipment', 'colour'], p, issues);
    const id = str(c, 'id', p, issues, { required: true, max: 24 });
    const label = str(c, 'label', p, issues, { max: PID_LIMITS.text.circuitLabel });
    const colour = str(c, 'colour', p, issues);
    if (colour && !isColour(colour))
      issues.errors.push(
        `${p}.colour: '${colour}' is not a colour (series-1..series-5 or #rrggbb).`,
      );
    else if (colour && isTrustColour(colour))
      issues.errors.push(TRUST_COLOUR_ERROR(`${p}.colour`, colour));
    const cl: string[] = [];
    list(c, 'lines', p, issues).forEach((v, i) => {
      if (typeof v !== 'string' || !lineIds.has(v)) {
        issues.errors.push(`${p}.lines[${i}]: no line '${String(v)}'.`);
        return;
      }
      if (lineOwner.has(v))
        issues.errors.push(
          `${p}.lines[${i}]: line '${v}' is already in circuit '${lineOwner.get(v)}'; a line belongs to one circuit.`,
        );
      else if (id) lineOwner.set(v, id);
      cl.push(v);
    });
    const ce: string[] = [];
    list(c, 'equipment', p, issues).forEach((v, i) => {
      if (typeof v !== 'string' || !equipment.some((e) => e.id === v))
        issues.errors.push(`${p}.equipment[${i}]: no equipment '${String(v)}'.`);
      else ce.push(v);
    });
    if (id)
      circuits.push({
        id,
        label: label ?? `CIRCUIT ${id}`,
        lines: cl,
        equipment: ce,
        ...(colour ? { colour } : {}),
      });
  }

  // The guide's complexity budget.
  const b = PID_LIMITS.budget;
  const valves = lines.reduce((s, l) => s + l.inline.length, 0);
  const loops = new Set(instruments.map((i) => i.loop)).size;
  const over = (what: string, n: number, max: number) => {
    if (n > max)
      issues.warnings.push(
        `budget: ${n} ${what} (the P&ID budget is ${max}); split by system or sheet with off-page connectors.`,
      );
  };
  over('equipment items', equipment.length, b.equipment);
  over('instrument bubbles', instruments.length, b.instruments);
  over('valves and inline items', valves, b.valves);
  over('control loops', loops, b.loops);
  over('process lines', lines.length, b.lines);
  const lineTypes =
    new Set(lines.map((l) => l.weight)).size +
    new Set(signals.map((s) => s.type).filter((t) => t !== 'connection')).size;
  over('line types in the legend', lineTypes, b.lineTypes);
  const accents =
    [...equipment, ...lines, ...instruments].filter((x) => x.focal).length +
    lines.reduce((s, l) => s + l.inline.filter((v) => v.focal).length, 0);
  over('accent elements', accents, b.accents);
  for (const i of instruments) {
    if (
      !i.on &&
      !endsAtBubble.has(i.tag) &&
      !signals.some((s) => s.from === i.tag || s.to === i.tag)
    ) {
      issues.warnings.push(
        `instruments '${i.tag}': connected to nothing (no 'on' and no signal); a bubble should not float.`,
      );
    }
  }

  return done(issues, {
    title,
    ...drawing,
    showTitle,
    legend,
    profile,
    equipment,
    offpage,
    lines,
    tees,
    instruments,
    signals,
    circuits,
    ...(description ? { description } : {}),
    ...(sheet ? { sheet } : {}),
    ...(legendNames ? { legendNames } : {}),
    ...(checks ? { checks } : {}),
    ...(provenance ? { provenance } : {}),
  });
}
