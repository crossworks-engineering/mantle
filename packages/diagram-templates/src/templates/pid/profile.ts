/**
 * The site profile: how ONE site draws its P&IDs. Every refinery and
 * contractor has its own legend sheet, so the template never hard-codes a
 * site's conventions; it reads them from a profile passed in as data. The
 * profile lives in each brain (client conventions are client data and never
 * go in this repo); `DEFAULT_PROFILE` is the generic ISA-5.1 starting point.
 */
import { SERIES, PALETTE, resolveColour } from '../../runtime/style.ts';

export type SymbolVariants = {
  /** How a normally closed manual valve is marked. */
  normallyClosed?: 'text' | 'filled';
  /** Check valve: one triangle filled, or an open bowtie with an arrow. */
  checkValve?: 'filled' | 'arrow';
  /** Process line corners: square (drawing-office practice) or 8px round. */
  corners?: 'square' | 'round';
  /** Where lines cross without joining: a semicircle hop or a 6px gap. */
  crossing?: 'hop' | 'gap';
  /** A deadleg branch: a cap and a DL tag (default), or the pipe dashed as
   *  well, where the site's drawings dash dead legs. */
  deadleg?: 'cap' | 'dashed';
};

export type CustomSymbol = {
  w: number;
  h: number;
  /** Paths in a w x h box, top-left at 0,0. Only path data, no markup. */
  paths: { d: string; fill?: 'none' | 'paper' | 'ink' }[];
};

export type SiteProfile = {
  name?: string;
  /** Line number format as a regular expression with named groups
   *  (`size`, `service`, `seq`, `class`). `service` drives service colour. */
  lineNumber?: { pattern: string; example?: string; enforce?: 'error' | 'warning' };
  /** Colour lines by service (otherwise monochrome, as most sheets issue). */
  colourByService?: boolean;
  /** Service code to colour: a series name (`series-2`) or `#rrggbb`. */
  serviceColours?: Record<string, string>;
  /** Extra first letters the site uses beyond ISA-5.1 (`X` for a site
   *  variable), with their meaning for the legend. */
  instrumentFirstLetters?: Record<string, string>;
  symbols?: SymbolVariants;
  /** Replace a built-in equipment or valve drawing by type name. */
  customSymbols?: Record<string, CustomSymbol>;
};

/** Size, service, sequence and pipe class: `4"-P-1024-CS150`. */
export const DEFAULT_LINE_PATTERN =
  '^(?<size>[0-9./]+")-(?<service>[A-Z]{1,4})-(?<seq>[0-9]{2,6})-(?<class>[A-Z0-9]{2,10})$';

/** Service colours from the guide (`type-pid.md`, Service colours). */
export const DEFAULT_SERVICE_COLOURS: Record<string, string> = {
  P: 'ink',
  ST: 'series-4',
  SC: 'series-4',
  CW: 'series-2',
  CWR: 'series-2',
  IA: 'series-1',
  PA: 'series-1',
  N: 'series-1',
  FG: 'series-3',
  FL: 'series-3',
  V: 'series-3',
  D: 'series-5',
  CH: 'series-5',
};

export const SERVICE_NAMES: Record<string, string> = {
  P: 'Process',
  ST: 'Steam',
  SC: 'Condensate',
  CW: 'Cooling water',
  CWR: 'Cooling water return',
  IA: 'Instrument air',
  PA: 'Plant air',
  N: 'Nitrogen',
  FG: 'Fuel gas',
  FL: 'Flare',
  V: 'Vent',
  D: 'Drain',
  CH: 'Chemical',
};

export type ResolvedProfile = {
  name: string;
  linePattern: RegExp;
  lineExample?: string;
  enforce: 'error' | 'warning';
  colourByService: boolean;
  serviceColour: (code: string | undefined) => string;
  firstLetters: Record<string, string>;
  symbols: Required<SymbolVariants>;
  customSymbols: Record<string, CustomSymbol>;
};

/** ISA-5.1 first letters (measured or initiating variable). */
export const FIRST_LETTERS: Record<string, string> = {
  A: 'Analysis',
  B: 'Burner, combustion',
  C: 'Conductivity',
  D: 'Density',
  E: 'Voltage',
  F: 'Flow',
  G: 'Gauging, position',
  H: 'Hand',
  I: 'Current',
  J: 'Power',
  K: 'Time',
  L: 'Level',
  M: 'Moisture',
  P: 'Pressure',
  Q: 'Quantity',
  R: 'Radiation',
  S: 'Speed, frequency',
  T: 'Temperature',
  U: 'Multivariable',
  V: 'Vibration',
  W: 'Weight, force',
  Y: 'Event, state',
  Z: 'Position',
};

/** Following letters: readout or passive functions, outputs, and modifiers. */
export const FOLLOWING_LETTERS = new Set([
  'A',
  'B',
  'C',
  'D',
  'E',
  'G',
  'H',
  'I',
  'K',
  'L',
  'M',
  'N',
  'O',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
]);

export function resolveProfile(p: SiteProfile | undefined): ResolvedProfile {
  const colours = { ...DEFAULT_SERVICE_COLOURS, ...(p?.serviceColours ?? {}) };
  return {
    name: p?.name ?? 'Generic ISA-5.1',
    linePattern: new RegExp(p?.lineNumber?.pattern ?? DEFAULT_LINE_PATTERN),
    ...(p?.lineNumber?.example ? { lineExample: p.lineNumber.example } : {}),
    enforce: p?.lineNumber?.enforce ?? 'warning',
    colourByService: p?.colourByService ?? false,
    serviceColour: (code) => resolveColour(code ? colours[code] : undefined, PALETTE.ink),
    firstLetters: { ...FIRST_LETTERS, ...(p?.instrumentFirstLetters ?? {}) },
    symbols: {
      normallyClosed: p?.symbols?.normallyClosed ?? 'text',
      checkValve: p?.symbols?.checkValve ?? 'filled',
      corners: p?.symbols?.corners ?? 'square',
      crossing: p?.symbols?.crossing ?? 'hop',
      deadleg: p?.symbols?.deadleg ?? 'cap',
    },
    customSymbols: p?.customSymbols ?? {},
  };
}

/** The parts of a line number under the profile's pattern, or null. */
export function parseLineNumber(
  profile: ResolvedProfile,
  num: string,
): Record<string, string> | null {
  const m = profile.linePattern.exec(num);
  if (!m) return null;
  return { ...(m.groups ?? {}) };
}

export const SERIES_NAMES = Object.keys(SERIES);
