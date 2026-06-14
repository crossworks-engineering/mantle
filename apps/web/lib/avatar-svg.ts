/**
 * Standalone SVG generator for boring-avatars, ported from `boring-avatars`
 * v2.0.4 (MIT) so it can run in a route handler.
 *
 * Why not call the library? Its components are React and use `useId()`. Rendering
 * them with `react-dom/server` inside a Next App Router route crashes with
 * `Cannot read properties of null (reading 'useId')`: the route's bundled React
 * runtime and the dynamically-imported `react-dom/server` are two different React
 * instances, so the hook dispatcher is null. This pure-string port has no React,
 * no hooks, and works in any runtime (node/edge, dev/prod).
 *
 * Parity: byte-for-byte geometry/colour parity with the library's output is
 * verified in `avatar-svg.test.ts` for every variant. `useId`-based element ids
 * (mask/gradient/filter) are replaced with static ids — safe because we emit a
 * single standalone avatar per SVG document, so they can't collide.
 */

// ── shared deterministic helpers (identical math to boring-avatars) ──────────
const hashCode = (name: string): number => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const character = name.charCodeAt(i);
    hash = (hash << 5) - hash + character;
    hash = hash & hash;
  }
  return Math.abs(hash);
};
const getDigit = (n: number, ntn: number) => Math.floor((n / Math.pow(10, ntn)) % 10);
const getBoolean = (n: number, ntn: number) => !(getDigit(n, ntn) % 2);
const getUnit = (n: number, range: number, index?: number) => {
  const value = n % range;
  if (index && getDigit(n, index) % 2 === 0) return -value;
  return value;
};
const getRandomColor = (n: number, colors: string[], range: number): string =>
  colors[n % range] ?? colors[0] ?? '#000000';
const getContrast = (hexcolor: string): string => {
  let hex = hexcolor;
  if (hex.slice(0, 1) === '#') hex = hex.slice(1);
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000000' : '#FFFFFF';
};

type Variant = 'pixel' | 'bauhaus' | 'ring' | 'beam' | 'sunset' | 'marble';

const svg = (size: number | string, viewBox: number, inner: string) =>
  `<svg viewBox="0 0 ${viewBox} ${viewBox}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${inner}</svg>`;

const mask = (viewBox: number, attrs = '') =>
  `<mask id="mask"${attrs} maskUnits="userSpaceOnUse" x="0" y="0" width="${viewBox}" height="${viewBox}"><rect width="${viewBox}" height="${viewBox}" rx="${viewBox * 2}" fill="#FFFFFF"/></mask>`;

// ── beam (face) — also the `geometric` alias ─────────────────────────────────
const SIZE_BEAM = 36;
function beam(name: string, colors: string[]): string {
  const c = SIZE_BEAM;
  const num = hashCode(name);
  const range = colors.length;
  const wrapperColor = getRandomColor(num, colors, range);
  const preTranslateX = getUnit(num, 10, 1);
  const wrapperTranslateX = preTranslateX < 5 ? preTranslateX + c / 9 : preTranslateX;
  const preTranslateY = getUnit(num, 10, 2);
  const wrapperTranslateY = preTranslateY < 5 ? preTranslateY + c / 9 : preTranslateY;
  const data = {
    wrapperColor,
    faceColor: getContrast(wrapperColor),
    backgroundColor: getRandomColor(num + 13, colors, range),
    wrapperTranslateX,
    wrapperTranslateY,
    wrapperRotate: getUnit(num, 360),
    wrapperScale: 1 + getUnit(num, c / 12) / 10,
    isMouthOpen: getBoolean(num, 2),
    isCircle: getBoolean(num, 1),
    eyeSpread: getUnit(num, 5),
    mouthSpread: getUnit(num, 3),
    faceRotate: getUnit(num, 10, 3),
    faceTranslateX: wrapperTranslateX > c / 6 ? wrapperTranslateX / 2 : getUnit(num, 8, 1),
    faceTranslateY: wrapperTranslateY > c / 6 ? wrapperTranslateY / 2 : getUnit(num, 7, 2),
  };
  const mouth = data.isMouthOpen
    ? `<path d="M15 ${19 + data.mouthSpread}c2 1 4 1 6 0" stroke="${data.faceColor}" fill="none" stroke-linecap="round"/>`
    : `<path d="M13,${19 + data.mouthSpread} a1,0.75 0 0,0 10,0" fill="${data.faceColor}"/>`;
  const inner =
    mask(c) +
    `<g mask="url(#mask)">` +
    `<rect width="${c}" height="${c}" fill="${data.backgroundColor}"/>` +
    `<rect x="0" y="0" width="${c}" height="${c}" transform="translate(${data.wrapperTranslateX} ${data.wrapperTranslateY}) rotate(${data.wrapperRotate} ${c / 2} ${c / 2}) scale(${data.wrapperScale})" fill="${data.wrapperColor}" rx="${data.isCircle ? c : c / 6}"/>` +
    `<g transform="translate(${data.faceTranslateX} ${data.faceTranslateY}) rotate(${data.faceRotate} ${c / 2} ${c / 2})">` +
    mouth +
    `<rect x="${14 - data.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${data.faceColor}"/>` +
    `<rect x="${20 + data.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${data.faceColor}"/>` +
    `</g></g>`;
  return svg(c, c, inner);
}

// ── bauhaus — also the `abstract` alias ──────────────────────────────────────
const SIZE_BAUHAUS = 80;
function bauhaus(name: string, colors: string[]): string {
  const o = SIZE_BAUHAUS;
  const num = hashCode(name);
  const range = colors.length;
  const el = (i: number) => ({
    color: getRandomColor(num + i, colors, range),
    translateX: getUnit(num * (i + 1), o / 2 - (i + 17), 1),
    translateY: getUnit(num * (i + 1), o / 2 - (i + 17), 2),
    rotate: getUnit(num * (i + 1), 360),
    isSquare: getBoolean(num, 2),
  });
  const t = [el(0), el(1), el(2), el(3)] as const;
  const inner =
    mask(o) +
    `<g mask="url(#mask)">` +
    `<rect width="${o}" height="${o}" fill="${t[0].color}"/>` +
    `<rect x="${(o - 60) / 2}" y="${(o - 20) / 2}" width="${o}" height="${t[1].isSquare ? o : o / 8}" fill="${t[1].color}" transform="translate(${t[1].translateX} ${t[1].translateY}) rotate(${t[1].rotate} ${o / 2} ${o / 2})"/>` +
    `<circle cx="${o / 2}" cy="${o / 2}" fill="${t[2].color}" r="${o / 5}" transform="translate(${t[2].translateX} ${t[2].translateY})"/>` +
    `<line x1="0" y1="${o / 2}" x2="${o}" y2="${o / 2}" stroke-width="2" stroke="${t[3].color}" transform="translate(${t[3].translateX} ${t[3].translateY}) rotate(${t[3].rotate} ${o / 2} ${o / 2})"/>` +
    `</g>`;
  return svg(o, o, inner);
}

// ── ring ─────────────────────────────────────────────────────────────────────
const SIZE_RING = 90;
function ring(name: string, colors: string[]): string {
  const p = SIZE_RING;
  const num = hashCode(name);
  const range = colors.length;
  const h = Array.from({ length: 5 }, (_unused, i) => getRandomColor(num + i, colors, range));
  const t = [h[0], h[1], h[1], h[2], h[2], h[3], h[3], h[0], h[4]];
  const inner =
    mask(p) +
    `<g mask="url(#mask)">` +
    `<path d="M0 0h90v45H0z" fill="${t[0]}"/>` +
    `<path d="M0 45h90v45H0z" fill="${t[1]}"/>` +
    `<path d="M83 45a38 38 0 00-76 0h76z" fill="${t[2]}"/>` +
    `<path d="M83 45a38 38 0 01-76 0h76z" fill="${t[3]}"/>` +
    `<path d="M77 45a32 32 0 10-64 0h64z" fill="${t[4]}"/>` +
    `<path d="M77 45a32 32 0 11-64 0h64z" fill="${t[5]}"/>` +
    `<path d="M71 45a26 26 0 00-52 0h52z" fill="${t[6]}"/>` +
    `<path d="M71 45a26 26 0 01-52 0h52z" fill="${t[7]}"/>` +
    `<circle cx="45" cy="45" r="23" fill="${t[8]}"/>` +
    `</g>`;
  return svg(p, p, inner);
}

// ── pixel — fixed cell layout, 64 colour-indexed squares ─────────────────────
const SIZE_PIXEL = 80;
// (x, y) of each 10×10 cell, in the library's exact draw order.
const PIXEL_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [20, 0], [40, 0], [60, 0], [10, 0], [30, 0], [50, 0], [70, 0],
  [0, 10], [0, 20], [0, 30], [0, 40], [0, 50], [0, 60], [0, 70],
  [20, 10], [20, 20], [20, 30], [20, 40], [20, 50], [20, 60], [20, 70],
  [40, 10], [40, 20], [40, 30], [40, 40], [40, 50], [40, 60], [40, 70],
  [60, 10], [60, 20], [60, 30], [60, 40], [60, 50], [60, 60], [60, 70],
  [10, 10], [10, 20], [10, 30], [10, 40], [10, 50], [10, 60], [10, 70],
  [30, 10], [30, 20], [30, 30], [30, 40], [30, 50], [30, 60], [30, 70],
  [50, 10], [50, 20], [50, 30], [50, 40], [50, 50], [50, 60], [50, 70],
  [70, 10], [70, 20], [70, 30], [70, 40], [70, 50], [70, 60], [70, 70],
];
function pixel(name: string, colors: string[]): string {
  const x = SIZE_PIXEL;
  const num = hashCode(name);
  const range = colors.length;
  const cells = PIXEL_CELLS.map(([cx, cy], i) => {
    const fill = getRandomColor(num % (i + 1), colors, range);
    return `<rect${cx ? ` x="${cx}"` : ''}${cy ? ` y="${cy}"` : ''} width="10" height="10" fill="${fill}"/>`;
  }).join('');
  const inner =
    mask(x, ' mask-type="alpha"') + `<g mask="url(#mask)">${cells}</g>`;
  return svg(x, x, inner);
}

// ── sunset — two vertically-stacked gradient bands ───────────────────────────
const SIZE_SUNSET = 80;
function sunset(name: string, colors: string[]): string {
  const w = SIZE_SUNSET;
  const num = hashCode(name);
  const range = colors.length;
  const t = Array.from({ length: 4 }, (_unused, i) => getRandomColor(num + i, colors, range));
  const inner =
    mask(w) +
    `<g mask="url(#mask)">` +
    `<path fill="url(#g0)" d="M0 0h80v40H0z"/>` +
    `<path fill="url(#g1)" d="M0 40h80v40H0z"/>` +
    `</g>` +
    `<defs>` +
    `<linearGradient id="g0" x1="${w / 2}" y1="0" x2="${w / 2}" y2="${w / 2}" gradientUnits="userSpaceOnUse"><stop stop-color="${t[0]}"/><stop offset="1" stop-color="${t[1]}"/></linearGradient>` +
    `<linearGradient id="g1" x1="${w / 2}" y1="${w / 2}" x2="${w / 2}" y2="${w}" gradientUnits="userSpaceOnUse"><stop stop-color="${t[2]}"/><stop offset="1" stop-color="${t[3]}"/></linearGradient>` +
    `</defs>`;
  return svg(w, w, inner);
}

// ── marble — two blurred, blended organic shapes ─────────────────────────────
const SIZE_MARBLE = 80;
function marble(name: string, colors: string[]): string {
  const g = SIZE_MARBLE;
  const num = hashCode(name);
  const range = colors.length;
  const el = (i: number) => ({
    color: getRandomColor(num + i, colors, range),
    translateX: getUnit(num * (i + 1), g / 10, 1),
    translateY: getUnit(num * (i + 1), g / 10, 2),
    scale: 1.2 + getUnit(num * (i + 1), g / 20) / 10,
    rotate: getUnit(num * (i + 1), 360, 1),
  });
  const t = [el(0), el(1), el(2)] as const;
  const inner =
    mask(g) +
    `<g mask="url(#mask)">` +
    `<rect width="${g}" height="${g}" fill="${t[0].color}"/>` +
    `<path filter="url(#filter)" d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z" fill="${t[1].color}" transform="translate(${t[1].translateX} ${t[1].translateY}) rotate(${t[1].rotate} ${g / 2} ${g / 2}) scale(${t[2].scale})"/>` +
    `<path filter="url(#filter)" style="mix-blend-mode:overlay" d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z" fill="${t[2].color}" transform="translate(${t[2].translateX} ${t[2].translateY}) rotate(${t[2].rotate} ${g / 2} ${g / 2}) scale(${t[2].scale})"/>` +
    `</g>` +
    `<defs><filter id="filter" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="7" result="effect1_foregroundBlur"/></filter></defs>`;
  return svg(g, g, inner);
}

const VARIANTS: Record<string, (name: string, colors: string[]) => string> = {
  pixel,
  bauhaus,
  ring,
  beam,
  sunset,
  marble,
  geometric: beam, // deprecated alias in boring-avatars
  abstract: bauhaus, // deprecated alias in boring-avatars
};

/**
 * Render a boring-avatars SVG to a string. `variant` falls back to `marble`
 * (the library's default) for unknown styles. `size` sets the svg width/height.
 */
export function renderAvatarSvg(opts: {
  name: string;
  variant?: string;
  colors: string[];
  size?: number | string;
}): string {
  const make = VARIANTS[opts.variant ?? 'marble'] ?? marble;
  const out = make(opts.name, opts.colors);
  // Each variant bakes its internal coordinate size into the root svg's
  // viewBox AND width/height; override only the root width/height (the first
  // occurrence in the string) with the requested render size. viewBox is left
  // intact so the artwork scales. Default 40px matches boring-avatars.
  const size = opts.size ?? '40px';
  return out.replace(
    /width="[^"]*" height="[^"]*"/,
    `width="${size}" height="${size}"`,
  );
}

export type { Variant };
