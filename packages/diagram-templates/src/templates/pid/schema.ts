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
import { isColour } from '../../runtime/style.ts';
import {
  FOLLOWING_LETTERS,
  parseLineNumber,
  resolveProfile,
  type CustomSymbol,
  type ResolvedProfile,
  type SiteProfile,
} from './profile.ts';

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
export type OffPage = { id: string; direction: 'in' | 'out'; sheet: string; text?: string };
export type InlineItem = {
  type: ValveType;
  tag?: string;
  actuator: 'diaphragm' | 'piston' | 'motor';
  fail?: 'FO' | 'FC' | 'FL';
  closed: boolean;
  focal: boolean;
};
export type Line = {
  id: string;
  number?: string;
  from: string;
  to: string;
  fromPort?: Port;
  toPort?: Port;
  service?: string;
  weight: 'main' | 'secondary';
  inline: InlineItem[];
  focal: boolean;
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
export type Circuit = {
  id: string;
  label: string;
  lines: string[];
  equipment: string[];
  colour?: string;
};

export type PidData = {
  title: string;
  description?: string;
  sheet?: { number?: string; revision?: string };
  profile: ResolvedProfile;
  showTitle: boolean;
  legend: boolean;
  equipment: Equipment[];
  offpage: OffPage[];
  lines: Line[];
  instruments: Instrument[];
  signals: Signal[];
  circuits: Circuit[];
};

/** Hard limits (errors) and the guide's complexity budget (warnings). */
export const PID_LIMITS = {
  equipment: 30,
  lines: 60,
  instruments: 60,
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
  'equipment',
  'offpage',
  'lines',
  'instruments',
  'signals',
  'circuits',
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
        ['normallyClosed', 'checkValve', 'corners', 'crossing'],
        'profile.symbols',
        issues,
      );
      const s = raw.symbols;
      const nc = oneOf(s, 'normallyClosed', ['text', 'filled'] as const, 'profile.symbols', issues);
      const cv = oneOf(s, 'checkValve', ['filled', 'arrow'] as const, 'profile.symbols', issues);
      const co = oneOf(s, 'corners', ['square', 'round'] as const, 'profile.symbols', issues);
      const cr = oneOf(s, 'crossing', ['hop', 'gap'] as const, 'profile.symbols', issues);
      out.symbols = {
        ...(nc ? { normallyClosed: nc } : {}),
        ...(cv ? { checkValve: cv } : {}),
        ...(co ? { corners: co } : {}),
        ...(cr ? { crossing: cr } : {}),
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

export function validatePid(input: unknown): Checked<PidData> {
  const issues = newIssues();
  if (!isObj(input)) return { ok: false, errors: ['data: must be a JSON object.'], warnings: [] };
  const d = input as Obj;
  checkKeys(d, TOP_KEYS, '', issues);
  if (d.template !== undefined && d.template !== 'pid') {
    issues.errors.push(
      `template: this is the 'pid' template, the data says '${String(d.template)}'.`,
    );
  }
  const title = str(d, 'title', '', issues, { required: true, max: 80 }) ?? '';
  const description = str(d, 'description', '', issues, { max: 300 });
  if (!description)
    issues.warnings.push(
      'description: add one sentence on what the sheet shows (screen readers read it).',
    );
  const showTitle = bool(d, 'showTitle', '', issues) ?? true;
  const legend = bool(d, 'legend', '', issues) ?? true;
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
  for (const [p, o] of objects(list(d, 'offpage', '', issues, { max: 20 }), 'offpage', issues)) {
    checkKeys(o, ['id', 'direction', 'sheet', 'text'], p, issues);
    const id = str(o, 'id', p, issues, tagRule);
    const direction = oneOf(o, 'direction', ['in', 'out'] as const, p, issues);
    if (o.direction === undefined)
      issues.errors.push(`${p}.direction: required, 'in' (comes from another sheet) or 'out'.`);
    const sheetNo = str(o, 'sheet', p, issues, { required: true, max: 12 });
    const text = str(o, 'text', p, issues, { max: 40 });
    if (id) claim(id, p);
    if (id && direction && sheetNo)
      offpage.push({ id, direction, sheet: sheetNo, ...(text ? { text } : {}) });
  }
  const ends = new Set([...equipment.map((e) => e.id), ...offpage.map((o) => o.id)]);
  const endHint = (v: string) => {
    const s = suggest(v, [...ends]);
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
        ],
        p,
        issues,
      );
      const number = str(l, 'number', p, issues, { max: 40 });
      const id = str(l, 'id', p, issues, { max: 40 }) ?? number ?? `L${i + 1}`;
      if (lineIds.has(id) && l.id !== undefined)
        issues.errors.push(`${p}.id: line id '${id}' is already used by ${lineIds.get(id)}.`);
      const from = str(l, 'from', p, issues, { required: true });
      const to = str(l, 'to', p, issues, { required: true });
      if (from && !ends.has(from))
        issues.errors.push(
          `${p}.from: no equipment or off-page connector '${from}'${endHint(from)}.`,
        );
      if (to && !ends.has(to))
        issues.errors.push(`${p}.to: no equipment or off-page connector '${to}'${endHint(to)}.`);
      if (from && to && from === to)
        issues.errors.push(`${p}: a line from '${from}' back to itself is not drawn.`);
      const fromPort = oneOf(l, 'fromPort', PORTS, p, issues);
      const toPort = oneOf(l, 'toPort', PORTS, p, issues);
      let service = str(l, 'service', p, issues, {
        max: 6,
        pattern: /^[A-Z]{1,6}$/,
        patternText: 'a service code in capitals (P, ST, CW)',
      });
      const weight = oneOf(l, 'weight', ['main', 'secondary'] as const, p, issues) ?? 'main';
      const focal = bool(l, 'focal', p, issues) ?? false;
      if (number) {
        const parts = parseLineNumber(profile, number);
        if (!parts) {
          const msg = `${p}.number: '${number}' does not match the site's line number format${profile.lineExample ? ` (for example ${profile.lineExample})` : ''}. Use the user's line number exactly; never make one up.`;
          (profile.enforce === 'error' ? issues.errors : issues.warnings).push(msg);
        } else if (!service && parts.service) service = parts.service;
      }
      const inline: InlineItem[] = [];
      for (const [ip, it] of objects(
        list(l, 'inline', p, issues, { max: 6 }),
        `${p}.inline`,
        issues,
      )) {
        checkKeys(it, ['type', 'tag', 'actuator', 'fail', 'closed', 'focal'], ip, issues);
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
          });
      }
      if (from && to && ends.has(from) && ends.has(to) && from !== to) {
        lineIds.set(id, p);
        lines.push({
          id,
          from,
          to,
          weight,
          inline,
          focal,
          ...(number ? { number } : {}),
          ...(fromPort ? { fromPort } : {}),
          ...(toPort ? { toPort } : {}),
          ...(service ? { service } : {}),
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

  const signalEnds = new Set([...instruments.map((i) => i.tag), ...inlineTags.keys()]);
  const signals: Signal[] = [];
  for (const [p, s] of objects(list(d, 'signals', '', issues, { max: 60 }), 'signals', issues)) {
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
  for (const [p, c] of objects(list(d, 'circuits', '', issues, { max: 12 }), 'circuits', issues)) {
    checkKeys(c, ['id', 'label', 'lines', 'equipment', 'colour'], p, issues);
    const id = str(c, 'id', p, issues, { required: true, max: 24 });
    const label = str(c, 'label', p, issues, { max: 40 });
    const colour = str(c, 'colour', p, issues);
    if (colour && !isColour(colour))
      issues.errors.push(
        `${p}.colour: '${colour}' is not a colour (series-1..series-5 or #rrggbb).`,
      );
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
    if (!i.on && !signals.some((s) => s.from === i.tag || s.to === i.tag)) {
      issues.warnings.push(
        `instruments '${i.tag}': connected to nothing (no 'on' and no signal); a bubble should not float.`,
      );
    }
  }

  return done(issues, {
    title,
    showTitle,
    legend,
    profile,
    equipment,
    offpage,
    lines,
    instruments,
    signals,
    circuits,
    ...(description ? { description } : {}),
    ...(sheet ? { sheet } : {}),
  });
}
