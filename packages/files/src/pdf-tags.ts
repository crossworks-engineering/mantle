/**
 * The tag grammar of drawing text, with no model: tokens, instrument tags in
 * the ISA-5.1 form, line numbers and equipment tags. Pure functions on
 * strings; the PDF drawing route (plan page 11a16779, section 10) and its
 * page facts both read text through here, so a tag has one canonical form.
 *
 * Written from the ISA-5.1 identification-letter table. The patterns are
 * generic ones. A token is only called a tag when its shape is clear, and
 * everything else stays plain text: a missed tag is still in the Texts
 * rows, and a false tag would be a wrong answer to a count.
 *
 * A site profile ({@link SiteProfile}) steers the grammar with four word
 * lists. A word is only ever looked up in a set: no pattern is built from
 * a word. With no profile, or an empty one, every function here gives what
 * it gave before there were profiles. The PDF drawing reader passes none,
 * so its rows do not change; the `after` pipeline Site tags passes the
 * box's (./site-tags.ts).
 */

import { canonicalTag } from './pdf-drawing-score';

/**
 * Split text into tokens: upper case, every kind of dash made the one `-`,
 * every inch mark the one `"` (the double prime, which NFKC makes two
 * primes, and the closing quote), the fraction slash a `/`, a whole number
 * before a fraction sign joined to it with a dash (`1½"` is `1-1/2"`), cut
 * at white space and `,;:()[]`, and with no full stop at its end (a tag
 * that ends a sentence). The one token form for the three grammars below
 * and for both counters of a page. A size written with a space (`1 1/2"`)
 * or a decimal comma (`1,5"`) is cut in two here, and its line number is
 * not read.
 */
export function tokensOf(text: string): string[] {
  return (
    text
      .replace(/(\d)(?=[\u00BC-\u00BE\u2150-\u215E])/g, '$1-')
      .normalize('NFKC')
      .toUpperCase()
      .replace(/[‐-―−]/g, '-')
      .replace(/′′|”/g, '"')
      .replace(/⁄/g, '/')
      .split(/[\s,;:()[\]]+/)
      // A token past the length bound is no tag: it keeps its dots, and the
      // strip costs nothing on a long run of them.
      .map((token) => (token.length > TOKEN_MAX_CHARS ? token : token.replace(/\.+$/, '')))
      .filter(Boolean)
  );
}

/** A token longer than this is no tag and no line number: the widest real
 *  one measured is under 30 characters, and the wide shape `TAG_LIKE`
 *  allows 51. It bounds what one token can cost and what a row's `Raw`
 *  holds. */
export const TOKEN_MAX_CHARS = 64;

/** A token with a letter, a digit and one to five dashes: the wide net. A
 *  count of these says "this page holds tags", not what each one is. */
export const TAG_LIKE = /^(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]{1,6}(-[A-Z0-9]{1,8}){1,5}$/;

// ─── ISA-5.1 instrument codes ─────────────────────────────────────────

/** First letters taken as a measured variable. The user's-choice letters
 *  (C, D, G, M, N, O) and R are left out: on a drawing they start equipment
 *  tags far more often than instrument codes. */
const VARIABLES = new Set('ABEFHIJKLPQSTUVWXYZ');
/** Succeeding letters: readout (A E G I L O P R W), output (C S T V Y Z)
 *  and the multi-function ones (U X). K (control station) is left out: TK
 *  is a tank. */
const FUNCTIONS = new Set('AEGILOPRWCSTVYZUX');
/**
 * Letters that parse as a code by the table and are something else on a
 * drawing: month names in a date (`APR-2026`), standards bodies
 * (`ISO-9001`, `API-650`) and plain words (`TAG-01`). Never a code.
 */
const MONTHS = new Set([
  ...['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC'],
]);
const NOT_CODES = new Set([
  ...MONTHS,
  ...[
    'ISO',
    'API',
    'ISA',
    'ASA',
    'AISI',
    'TAG',
    'EXP',
    'REV',
    'ITEM',
    'ZONE',
    'AREA',
    'SIZE',
    'TYPE',
  ],
]);
/** Valve and device codes in wide use that the letter table does not make. */
const DEVICE_CODES = new Set(['SDV', 'BDV', 'ESDV', 'ESV', 'MOV', 'ROV', 'RO', 'NRV', 'PVRV']);

/**
 * A site's own steer of the grammar: four word lists, upper case (the
 * option check makes them so). Empty lists change nothing.
 */
export type SiteProfile = {
  /** Type letters that are always equipment, also when they read as an ISA code: EA, HX. */
  equipmentTypes: readonly string[];
  /** More device codes that are instruments (added to DEVICE_CODES). */
  instrumentCodes: readonly string[];
  /** A site's own words that are never a tag (added to NOT_TAG_WORDS and NOT_CODES). */
  notTags: readonly string[];
  /** Service codes: a token of 3 to 7 dash parts with a serial, one of these, and no size part is a line number. */
  lineServices: readonly string[];
};

/** A profile as sets, made once for each profile object. Null for no
 *  profile or an empty one: then the grammar is the one of no profile. */
type Sets = {
  equipmentTypes: ReadonlySet<string>;
  instrumentCodes: ReadonlySet<string>;
  notTags: ReadonlySet<string>;
  lineServices: ReadonlySet<string>;
};
const SETS = new WeakMap<SiteProfile, Sets | null>();

function setsOf(profile: SiteProfile | undefined): Sets | null {
  if (!profile) return null;
  let sets = SETS.get(profile);
  if (sets === undefined) {
    const lists = [
      profile.equipmentTypes,
      profile.instrumentCodes,
      profile.notTags,
      profile.lineServices,
    ];
    sets = lists.every((l) => l.length === 0)
      ? null
      : {
          equipmentTypes: new Set(profile.equipmentTypes),
          instrumentCodes: new Set(profile.instrumentCodes),
          notTags: new Set(profile.notTags),
          lineServices: new Set(profile.lineServices),
        };
    SETS.set(profile, sets);
  }
  return sets;
}

export type IsaRole = 'sensor' | 'controller' | 'final_element';

export type IsaCode = {
  /** The letters as written, upper case. */
  code: string;
  /** The measured variable letter, or '' for a device code. */
  variable: string;
  /** D differential, F ratio, Q total, S safety; or ''. */
  modifier: string;
  /** The function letters, without the level letters. */
  functions: string;
  /** HH, H, L, LL; or ''. */
  level: string;
  role: IsaRole;
};

/**
 * Read 2 to 6 letters as an ISA-5.1 code, or null when they do not form
 * one. `FIC`: F, I C, a controller. `PDT`: P with modifier D, T. `PSV`: P
 * with modifier S, V, a final element. `LSHH`: L, S, level HH. A valid
 * code is not yet an instrument: plain words (`LA`, `TE`) also parse, so a
 * caller asks for the loop number beside it ({@link parseInstrumentTag}).
 */
export function parseIsaCode(letters: string, profile?: SiteProfile): IsaCode | null {
  const code = letters.toUpperCase();
  const site = setsOf(profile);
  if (!/^[A-Z]{2,6}$/.test(code) || NOT_CODES.has(code) || site?.notTags.has(code)) return null;
  if (DEVICE_CODES.has(code) || site?.instrumentCodes.has(code)) {
    return { code, variable: '', modifier: '', functions: code, level: '', role: 'final_element' };
  }
  const variable = code[0]!;
  if (!VARIABLES.has(variable)) return null;
  let rest = code.slice(1);
  let modifier = '';
  const next = rest[0]!;
  const after = rest[1];
  // D, F and Q modify the variable when a function letter follows them; S
  // is "safety" only before a valve or an element (PSV, PSE), else a switch.
  if (after !== undefined) {
    if (next === 'D' || next === 'Q' || (next === 'F' && variable === 'F')) modifier = next;
    else if (next === 'S' && (after === 'V' || after === 'E')) modifier = 'S';
  }
  if (modifier) rest = rest.slice(1);
  const level = /(HH|LL|H|L)$/.exec(rest)?.[1] ?? '';
  // The level letters end a code only when a function letter is left before
  // them: in `LL` (level light) the last L is the function.
  const functions = level && rest.length > level.length ? rest.slice(0, -level.length) : rest;
  const lvl = functions === rest ? '' : level;
  if (!functions || ![...functions].every((c) => FUNCTIONS.has(c))) return null;
  const role: IsaRole =
    functions.includes('V') || functions.includes('Z')
      ? 'final_element'
      : functions.includes('C')
        ? 'controller'
        : 'sensor';
  return { code, variable, modifier, functions, level: lvl, role };
}

export type InstrumentTag = {
  /** Canonical form: `PREFIX-CODE-LOOP` with the suffix on the loop. */
  tag: string;
  /** The area or unit part before the code, or ''. */
  prefix: string;
  isa: IsaCode;
  /** The loop number with its suffix letter, as written (`0012`, `101A`). */
  loop: string;
  /** Variable and loop: `F-101` joins FT-101, FIC-101 and FV-101. '' for a
   *  device code. */
  loopKey: string;
};

const LOOP = /^(\d{2,6})([A-Z]{0,2})$/;
const ONE_TOKEN = /^(?:([A-Z0-9]{1,6})-|(\d{1,4}))?([A-Z]{2,6})-?(\d{2,6}[A-Z]{0,2})$/;

/** Build the tag from its parts (the parts of a bubble, or of one token). */
export function instrumentTagOf(
  code: string,
  loop: string,
  prefix = '',
  profile?: SiteProfile,
): InstrumentTag | null {
  const isa = parseIsaCode(code, profile);
  const m = LOOP.exec(loop.toUpperCase());
  if (!isa || !m) return null;
  // The tag keeps its digits as written: `FIC-0012` and `FIC-12` can be two
  // loops. Only the loop key, which joins the instruments of one loop,
  // drops the leading zeros.
  const number = m[1]!.replace(/^0+(?=\d)/, '');
  const pre = canonicalTag(prefix, false);
  return {
    tag: [pre, isa.code, `${m[1]}${m[2]}`].filter(Boolean).join('-'),
    prefix: pre,
    isa,
    loop: loop.toUpperCase(),
    loopKey: isa.variable ? `${isa.variable}-${number}` : '',
  };
}

/** Read one token as an instrument tag: `FIC-1234`, `PT1234A`, `40-PSV-0012`,
 *  `40PSV0012`. Null when the letters are not an ISA code or there is no
 *  loop number of two digits or more. */
export function parseInstrumentTag(token: string, profile?: SiteProfile): InstrumentTag | null {
  const m = ONE_TOKEN.exec(token.toUpperCase());
  if (!m) return null;
  return instrumentTagOf(m[3]!, m[4]!, m[1] ?? m[2] ?? '', profile);
}

// ─── line numbers ─────────────────────────────────────────────────────

/** Nominal pipe sizes in millimetres (DN), for a size written with no inch
 *  mark. */
const DN = new Set([
  15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 750,
  800, 900, 1000, 1050, 1200,
]);

/** A size part: `4"`, `1.5"`, `1/2"`, `1-1/2"` (joined by
 *  {@link parseLineNumber}), `DN100`, or a bare DN number. Returns the size
 *  as written. */
function sizePart(part: string): string | null {
  if (/^\d{1,2}(\.\d)?"$/.test(part) || /^([1-3]-)?\d\/\d"$/.test(part)) return part;
  const dn = /^(?:DN)?(\d{2,4})$/.exec(part);
  if (dn && (part.startsWith('DN') || DN.has(Number(dn[1])))) return part;
  return null;
}

export type LineNumber = {
  /** Canonical form: the parts joined with one dash, upper case. */
  line: string;
  /** The size part as written (`4"`, `DN100`, `100`). */
  size: string;
  /** The longest all-digit part of three digits or more: the serial. */
  serial: string;
};

/**
 * Read one token (of {@link tokensOf}) as a pipe line number: three to
 * seven dash parts, of which one is a size, one is a serial number of three
 * digits or more, and one holds a letter (a service or a pipe class).
 * `4"-P-1234-A1B`, `1-1/2"-P-1234-A1B`, `100-HC-12345-B2A-IH`,
 * `P-1234-4"-A1B`. Null for anything else.
 *
 * A bare DN number counts as the size only when another part is the serial:
 * `100-200-P` has no serial apart from the sizes, so it is no line number.
 *
 * With a profile's line services, a token with no size part is a line
 * number too, when one part is one of the services and another is a serial
 * of three digits or more: `P-1001-A1A` with the service `P`. Its size is
 * ''.
 */
export function parseLineNumber(token: string, profile?: SiteProfile): LineNumber | null {
  const parts = token.split('-');
  if (parts.some((p) => !/^[A-Z0-9"./]+$/.test(p))) return null;
  // A whole inch before a fraction is one size: `1-1/2"`. A fraction size
  // has a whole part of 1, 2 or 3 only, so a unit number is not joined.
  const whole = parts.findIndex(
    (p, i) => /^[1-3]$/.test(p) && /^\d\/\d"$/.test(parts[i + 1] ?? ''),
  );
  if (whole >= 0) parts.splice(whole, 2, `${parts[whole]}-${parts[whole + 1]}`);
  if (parts.length < 3 || parts.length > 7) return null;
  // A date: `15-JAN-2026` has a day that is a pipe size and a year that
  // would pass for a serial. A month written out (`15-JUNE-2026`) too: an
  // all-letter part that starts as a month does.
  if (parts.some((p) => MONTHS.has(p) || (/^[A-Z]{4,9}$/.test(p) && MONTHS.has(p.slice(0, 3))))) {
    return null;
  }
  // The inch mark is the sure sign; a bare number is second choice.
  const marked = parts.findIndex((p) => p.endsWith('"') && sizePart(p));
  const sizeAt = marked >= 0 ? marked : parts.findIndex((p) => sizePart(p));
  if (sizeAt < 0) return serviceLine(parts, setsOf(profile));
  // With no inch mark on the size, a number that is itself a pipe size is
  // not taken as the serial: two bare sizes do not make a line number.
  const serials = parts.filter(
    (p, i) => i !== sizeAt && /^\d{3,6}$/.test(p) && (marked >= 0 || !DN.has(Number(p))),
  );
  if (serials.length === 0) return null;
  if (!parts.some((p, i) => i !== sizeAt && /[A-Z]/.test(p))) return null;
  const serial = serials.reduce((a, b) => (b.length > a.length ? b : a));
  return { line: parts.join('-'), size: parts[sizeAt]!, serial };
}

/** A line number with no size part, by a profile's service codes: one part
 *  is a service, another a serial. Null with no services. */
function serviceLine(parts: readonly string[], site: Sets | null): LineNumber | null {
  if (!site || site.lineServices.size === 0) return null;
  const at = parts.findIndex((p) => site.lineServices.has(p));
  if (at < 0) return null;
  const serials = parts.filter((p, i) => i !== at && /^\d{3,6}$/.test(p));
  if (serials.length === 0) return null;
  const serial = serials.reduce((a, b) => (b.length > a.length ? b : a));
  return { line: parts.join('-'), size: '', serial };
}

// ─── equipment tags ───────────────────────────────────────────────────

export type EquipmentTag = {
  /** Canonical form: upper case, one kind of dash, no spaces; the digits
   *  as written. */
  tag: string;
  /** The unit part before the type letters, or ''. */
  unit: string;
  /** The type letters: `E` in `U2-E-12A`. */
  type: string;
  /** The number with its suffix letters: `12A`. */
  number: string;
  /** A fourth part, as written: a part of the item (`E1`, `E-1A`), or ''. */
  sub: string;
};

/**
 * The join form of a tag: its letters and digits only. One item is written
 * `U2-C-1A-E1A` on one sheet and `U2-C-1A-E-1A` on another (bench measure,
 * 2026-11-11: 16 of 119 catalog tags are on their sheet in the other dash
 * form); both have the key `U2C1AE1A`. A key can join two tags that differ
 * only in where the dash is (`E-11`, `E1-1`), so it is a second column, and
 * the tag stays as written. The digits stay as written too: `P-0101` and
 * `P-101` have two keys.
 */
export function tagKey(tag: string): string {
  return canonicalTag(tag, false).replace(/[^A-Z0-9]/g, '');
}

/**
 * Words that take the place of the type letters and are no tag: standards
 * bodies, the words of a drawing's own frame and notes, and pipe terms.
 * `REV-2`, `NOTE-3`, `ISO-9001`, `DN-100`. Generic ones only: a site's own
 * words are for its site profile.
 */
const NOT_TAG_WORDS = new Set([
  ...NOT_CODES,
  ...['ASME', 'ANSI', 'ASTM', 'DIN', 'EN', 'BS', 'NFPA', 'IEC', 'JIS', 'UNE', 'NACE'],
  ...['NOTE', 'FIG', 'DWG', 'DRG', 'SHT', 'SH', 'REF', 'DET', 'SEC', 'NO', 'TYP', 'PAGE', 'PG'],
  ...['DN', 'PN', 'NPS', 'SCH', 'CL', 'PO', 'WO', 'ID', 'OD'],
]);

/** Unit, type letters, number, and an optional fourth part (`E1`, `E1A`,
 *  `E-1A`). */
const EQUIPMENT =
  /^(?:([A-Z0-9]{1,6})-)?([A-Z]{1,4})-(\d{1,5}[A-Z]{0,2})(?:-([A-Z]{1,3}-?\d{1,3}[A-Z]{0,2}))?$/;
/** A list after a token: `/B`, `/B/C`, `/2`. */
const SLASH_LIST = /^([^/]+)((?:\/[A-Z0-9]{1,3})+)$/;

/**
 * The tokens one token stands for. A plain token stands for itself. A token
 * with a list after it stands for one token an item, the last letters (or
 * digits) of the token changed for the item's: `P-1A/B` is `P-1A` and
 * `P-1B`, `PSV-101A/B` is `PSV-101A` and `PSV-101B`, `E-1/2` is `E-1` and
 * `E-2`. Empty when an item does not fit the token's end (letters after a
 * digit, or longer than what it would change): a half-read list would be a
 * wrong tag. A token is split only when it is no tag whole
 * ({@link tokenItems}), so a list reads the same for every kind of tag.
 */
export function listItemsOf(token: string): string[] {
  const list = SLASH_LIST.exec(token);
  if (!list) return [token];
  const base = list[1]!;
  const out = [base];
  for (const item of list[2]!.split('/').filter(Boolean)) {
    const end = /^[A-Z]+$/.test(item)
      ? /[A-Z]+$/.exec(base)
      : /^\d+$/.test(item)
        ? /\d+$/.exec(base)
        : null;
    if (!end || item.length > end[0].length) return [];
    out.push(base.slice(0, base.length - item.length) + item);
  }
  return out;
}

/**
 * Read one token as an equipment tag: an optional unit part, one to four
 * type letters and a number, with dashes between (`E-101`, `U2-TK-1`,
 * `50-P-12A/B`). Null for an instrument tag: `PT-1234` is the instrument,
 * whatever else its letters could mean.
 */
export function parseEquipmentTag(token: string, profile?: SiteProfile): EquipmentTag | null {
  const t = canonicalTag(token, false);
  const site = setsOf(profile);
  const m = EQUIPMENT.exec(t);
  // A profile's equipment type letters win over the ISA reading: `EA-101`.
  const sure = m !== null && site?.equipmentTypes.has(m[2]!) === true;
  if (!sure && parseInstrumentTag(t, profile)) return null;
  if (!m || NOT_TAG_WORDS.has(m[2]!) || site?.notTags.has(m[2]!)) return null;
  return { tag: t, unit: m[1] ?? '', type: m[2]!, number: m[3]!, sub: m[4] ?? '' };
}

/** Whether a profile calls this item equipment before any other trial: its
 *  type letters are one of the profile's equipment types. */
function siteEquipment(item: string, profile: SiteProfile | undefined): boolean {
  const site = setsOf(profile);
  if (!site || site.equipmentTypes.size === 0) return false;
  const m = EQUIPMENT.exec(canonicalTag(item, false));
  return m !== null && site.equipmentTypes.has(m[2]!) && !site.notTags.has(m[2]!);
}

export type TokenKind = 'instrument' | 'line' | 'equipment';

/** The kind of one token with no list, in the one order of trial. A
 *  profile's equipment types go first. */
export function itemKind(item: string, profile?: SiteProfile): TokenKind | null {
  if (siteEquipment(item, profile)) return 'equipment';
  if (parseInstrumentTag(item, profile)) return 'instrument';
  if (parseLineNumber(item, profile)) return 'line';
  return parseEquipmentTag(item, profile) ? 'equipment' : null;
}

/**
 * What one token is by the grammar, and the tokens it stands for. The whole
 * token is tried first, in the one order of trial ({@link itemKind}): an
 * instrument tag, then a line number, then an equipment tag. Only when the
 * whole token is none of them is a list after it split ({@link listItemsOf})
 * and each item tried: so a line number with a slash in a part
 * (`6"-HC-1001-B2A/H`) stays one line, and `PSV-101A/B` is two instrument
 * tags. Null when no pattern fits, when the items of a list are not all of
 * one kind (such a list is in no tab), and for a token past
 * {@link TOKEN_MAX_CHARS}. The counts of a page and its rows both go by
 * this, and read the items from here.
 *
 * With no profile the order puts two real forms in another tab: equipment
 * written with two letters that are also an ISA code (`EA-101`, `HX-101`)
 * is an instrument, and a line number written with no size part
 * (`P-1001-A1A`) is equipment with a fourth part. The key and the letters
 * stay right. A site profile mends both: `equipmentTypes: ['EA']` and
 * `lineServices: ['P']`.
 */
export function tokenItems(
  token: string,
  profile?: SiteProfile,
): { kind: TokenKind; items: string[] } | null {
  if (token.length > TOKEN_MAX_CHARS) return null;
  const whole = itemKind(token, profile);
  if (whole) return { kind: whole, items: [token] };
  const items = listItemsOf(token);
  if (items.length < 2) return null;
  const kind = itemKind(items[0]!, profile);
  return kind && items.every((item) => itemKind(item, profile) === kind) ? { kind, items } : null;
}

/** The kind alone of {@link tokenItems}. */
export function tokenKind(token: string, profile?: SiteProfile): TokenKind | null {
  return tokenItems(token, profile)?.kind ?? null;
}
