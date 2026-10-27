/**
 * The house style, as code. The values come from the diagram guides'
 * style guide (`docs/diagram-guides/style-guide.md`, light skin) and the
 * Draftsman `diagram_design` skill: the palette, the node treatments, the
 * font roles resolved to system stacks (a static SVG shown through `<img>`
 * cannot load web fonts) and the spacing grid. A template reads these and
 * nothing else, so a skin change is one edit here.
 */

export const PALETTE = {
  paper: '#f5f5f5',
  paper2: '#ececec',
  white: '#ffffff',
  ink: '#2d3142',
  muted: '#4f5d75',
  soft: '#5a6580',
  rule: 'rgba(45,49,66,0.12)',
  ruleSolid: '#bfc0c0',
  /** Focal only, 1 or 2 elements per diagram. Darkened from the raw brand
   *  tangerine so it clears 4.5:1 as text on paper. */
  accent: '#bf4520',
  /** accent at 8% on paper, flattened. */
  accentTint: '#f1e4e0',
  link: '#2e5aa8',
} as const;

/** The series palette (style guide): for services, circuits and other sets
 *  that need telling apart. Never the accent. */
export const SERIES = {
  'series-1': '#7c8f6f',
  'series-2': '#5e7a9b',
  'series-3': '#b8915a',
  'series-4': '#9c6b50',
  'series-5': '#6e6479',
} as const;
export type SeriesName = keyof typeof SERIES;

export const FONT = {
  serif: 'Iowan Old Style, Palatino Linotype, Georgia, serif',
  sans: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

/** A font role: what a piece of text is, not how it looks. */
export type TextRole =
  'title' | 'nodeName' | 'sublabel' | 'eyebrow' | 'arrowLabel' | 'legend' | 'tag';

export type FontSpec = {
  family: string;
  size: number;
  weight: number;
  /** Letter spacing in px (SVG `letter-spacing`). */
  tracking: number;
  upper: boolean;
};

export const ROLES: Record<TextRole, FontSpec> = {
  title: { family: FONT.serif, size: 20, weight: 400, tracking: 0, upper: false },
  nodeName: { family: FONT.sans, size: 12, weight: 600, tracking: 0, upper: false },
  sublabel: { family: FONT.mono, size: 9, weight: 400, tracking: 0, upper: false },
  eyebrow: { family: FONT.mono, size: 8, weight: 500, tracking: 1.2, upper: true },
  arrowLabel: { family: FONT.mono, size: 8, weight: 400, tracking: 0.5, upper: true },
  legend: { family: FONT.mono, size: 8, weight: 400, tracking: 0.5, upper: true },
  tag: { family: FONT.mono, size: 7, weight: 500, tracking: 0.8, upper: true },
};

/** Every coordinate, size and gap is a multiple of this (the 4px grid). */
export const GRID = 4;

export const SPACE = {
  /** Inner padding of a node box. */
  pad: 12,
  /** Gap between neighbouring nodes in one rank. */
  nodeGap: 40,
  /** Gap between ranks before routing tracks are added. */
  rankGap: 56,
  /** Distance between parallel connector runs. */
  track: 12,
  /** Corner radius of a connector elbow. */
  elbow: 8,
  /** Gap between an arrow label's mask and its text. */
  labelPadX: 6,
  labelPadY: 4,
  /** Outer margin of the drawing. */
  margin: 32,
  /** Height of the legend strip (below a hairline). */
  legend: 48,
  radius: 6,
} as const;

/** An `rgba()` colour flattened onto paper, so a fill hides what is behind
 *  it (a line passing under a box must not show through). */
export function opaque(rgba: string, under: string = PALETTE.paper): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(rgba);
  if (!m) return rgba;
  const base = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  const a = Number(m[4]);
  const mix = [1, 2, 3].map((i, k) => Math.round(Number(m[i]) * a + base[k]! * (1 - a)));
  return '#' + mix.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** Node treatments by kind (style guide, "Node type to treatment"). Fills are
 *  flattened onto paper. */
export type NodeKind =
  'backend' | 'focal' | 'store' | 'external' | 'input' | 'optional' | 'security';

export const NODE_KINDS: Record<
  NodeKind,
  { fill: string; stroke: string; dash?: string; legend: string }
> = {
  backend: { fill: PALETTE.white, stroke: PALETTE.ink, legend: 'Component' },
  focal: { fill: PALETTE.accentTint, stroke: PALETTE.accent, legend: 'Focal' },
  store: { fill: opaque('rgba(45,49,66,0.05)'), stroke: PALETTE.muted, legend: 'Store' },
  external: {
    fill: opaque('rgba(45,49,66,0.03)'),
    stroke: 'rgba(45,49,66,0.30)',
    legend: 'External',
  },
  input: { fill: opaque('rgba(79,93,117,0.10)'), stroke: PALETTE.soft, legend: 'Input' },
  optional: {
    fill: opaque('rgba(45,49,66,0.02)'),
    stroke: 'rgba(45,49,66,0.20)',
    dash: '4,3',
    legend: 'Optional',
  },
  security: {
    fill: opaque('rgba(191,69,32,0.05)'),
    stroke: 'rgba(191,69,32,0.50)',
    dash: '4,4',
    legend: 'Security boundary',
  },
};

export type EdgeTone = 'muted' | 'accent' | 'link';
export const EDGE_TONES: Record<EdgeTone, string> = {
  muted: PALETTE.muted,
  accent: PALETTE.accent,
  link: PALETTE.link,
};

/** Round up to the grid. */
export function gridUp(n: number): number {
  return Math.ceil(n / GRID - 1e-9) * GRID;
}

/** Round to the nearest grid line. */
export function gridRound(n: number): number {
  return Math.round(n / GRID) * GRID;
}

/**
 * The drawing style edition a template's data asks for (`style`):
 *  - 1, or absent: the classic monochrome style, every drawing saved before
 *    the colour set came in. It draws byte for byte as it always did
 *    (src/unchanged-output.test.ts pins it).
 *  - 2: the colour set below, with label placement that keeps connector
 *    text, notes and page references off each other. circuit_trace writes
 *    it on every drawing it makes, and an author may ask for it; a saved
 *    drawing keeps the edition it was saved with.
 */
export const STYLE_EDITIONS = [1, 2] as const;
export type StyleEdition = (typeof STYLE_EDITIONS)[number];
export const CURRENT_STYLE: StyleEdition = 2;

/**
 * ONE fixed colour set for what a line or a label MEANS on a P&ID (style 2).
 * Every colour clears 4.5:1 against the paper (and against white, a marker's
 * fill), so the same colour serves a line (3:1 needed) and its text (4.5:1);
 * src/colour-set.test.ts computes the WCAG ratios. Colour never carries
 * meaning alone: each role also has its own weight or dash (ROLE_STROKES)
 * or its own words on the drawing, so a grey print still reads.
 *
 * The image check's crop overlay names the same three line colours
 * (main red, branch blue, deadleg orange).
 */
export const ROLE_COLOURS = {
  /** The main process line. */
  main: '#b42318',
  /** A branch off the main line. */
  branch: '#1d5fa8',
  /** A dead leg. */
  deadleg: '#a14a00',
  /** Valves, inline items, instrument bubbles and their connections. */
  instrument: '#6a3d9a',
  /** A label that says GUESS (the trace's plain word). */
  guess: '#7a5a00',
  /** A label that says CHECKED BY IMAGE (the image check said yes; a help,
   *  not a guarantee). */
  checked: '#256b2a',
  /** A label that says IMAGE: NO (still a guess). */
  contradicted: '#a8155c',
  /** A label that says FROM IMAGE (drawn as the image check named it). */
  corrected: '#4338ca',
  /** An off-page connector, a page link, a page reference. */
  link: '#0b6e75',
} as const;
export type LineRole = keyof typeof ROLE_COLOURS;

/** The weight and dash of each role's line: what tells them apart in grey. */
export const ROLE_STROKES: Record<
  'main' | 'branch' | 'deadleg' | 'guess',
  { width: number; dash?: string }
> = {
  main: { width: 2.4 },
  branch: { width: 1.4 },
  deadleg: { width: 1.4, dash: '8,4' },
  /** A guessed connector's outline (its text says GUESS): dotted. */
  guess: { width: 1.4, dash: '2,3' },
};

/** WCAG 2 relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A colour from a series name, a palette name or a literal `#rrggbb`. */
export function resolveColour(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value in SERIES) return SERIES[value as SeriesName];
  if (value in PALETTE) return PALETTE[value as keyof typeof PALETTE];
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return fallback;
}

/** True for a colour `resolveColour` accepts. */
export function isColour(value: string): boolean {
  return value in SERIES || value in PALETTE || /^#[0-9a-fA-F]{6}$/.test(value);
}
