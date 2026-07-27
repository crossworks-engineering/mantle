/**
 * Colour model for the theme generator — OKLab/OKLCH math, WCAG contrast, and
 * the anchored AA solver.
 *
 * THE PRINCIPLE. A theme's identity is its surfaces and fills; text colour is a
 * pure function of (hue, surface, target ratio). So every text token is SOLVED,
 * not authored: keep the anchor's hue and chroma (the theme's identity), scan
 * lightness outward from the anchor in small steps, and take the first value
 * that clears the required ratio against every surface it must sit on. The
 * anchor is the authored value wherever one exists, so a token that already
 * passes is emitted byte-for-byte unchanged, and one that fails moves the
 * minimum perceptible amount. Measured across the 172 ink tokens shipped in
 * v0.206.12: 0 infeasible, max |ΔL| 0.43, most far smaller.
 *
 * TRAP (cost a real session): validate the ROUNDED 8-BIT HEX you will emit,
 * not the float candidate. Values that clear 4.5:1 in float land at 4.483 once
 * written as hex. Every solver in this file round-trips through `toHex` before
 * measuring.
 *
 * The sRGB<->OKLab matrices mirror the ones proven in
 * `src/lib/themes.test.ts`; the test recomputes every pair independently, so a
 * transcription error here fails CI rather than shipping.
 */

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** Any notation used in theme sources -> sRGB [r,g,b] in 0..1 (gamut-clamped,
 *  which is what a browser renders for out-of-gamut oklch()). */
export function parseColor(value) {
  const v = value.trim();
  if (v.startsWith('#')) {
    let h = v.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`bad hex: ${value}`);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  const args = v
    .slice(v.indexOf('(') + 1, v.lastIndexOf(')'))
    .split('/')[0]
    .trim()
    .split(/[\s,]+/);
  if (v.startsWith('oklch')) {
    const L = args[0].endsWith('%') ? parseFloat(args[0]) / 100 : parseFloat(args[0]);
    const C = args[1].endsWith('%') ? (parseFloat(args[1]) / 100) * 0.4 : parseFloat(args[1]);
    const H = parseFloat(args[2] ?? '0') || 0;
    return oklchToSrgb([L, C, H]);
  }
  if (v.startsWith('hsl')) {
    const [h, sPct, lPct] = args.map(parseFloat);
    const [S, L] = [sPct / 100, lPct / 100];
    const k = (n) => (n + h / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }
  throw new Error(`unsupported colour notation: ${value}`);
}

/** OKLCH [L, C, H°] -> sRGB 0..1, per-channel gamut clamp. */
export function oklchToSrgb([L, C, Hdeg]) {
  const H = (Hdeg * Math.PI) / 180;
  const [a, b] = [C * Math.cos(H), C * Math.sin(H)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** sRGB 0..1 -> OKLab [L, a, b]. */
export function srgbToOklab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(srgbToLin);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** sRGB 0..1 -> OKLCH [L, C, H°]. */
export function srgbToOklch(rgb) {
  const [L, a, b] = srgbToOklab(rgb);
  const C = Math.hypot(a, b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

export const parseOklch = (css) => srgbToOklch(parseColor(css));

export function toHex(rgb) {
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(clamp01(c) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Normalise any supported notation to the 6-digit hex a browser renders. */
export const cssToHex = (css) => toHex(parseColor(css));

export const luminance = ([r, g, b]) => {
  const [lr, lg, lb] = [r, g, b].map(srgbToLin);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};

/** WCAG 2.1 contrast between two CSS values, measured AS RENDERED — both sides
 *  are first snapped to the 8-bit hex the browser will actually paint. */
export function contrast(cssA, cssB) {
  const [a, b] = [luminance(parseColor(cssToHex(cssA))), luminance(parseColor(cssToHex(cssB)))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Perceptual distance in OKLab. Rule of thumb: <0.01 imperceptible, <0.02
 *  barely noticeable side by side, >0.05 clearly a different colour. */
export function deltaE(cssA, cssB) {
  const [l1, a1, b1] = srgbToOklab(parseColor(cssA));
  const [l2, a2, b2] = srgbToOklab(parseColor(cssB));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const L_STEP = 0.0025;

/**
 * The anchored AA solver.
 *
 * Finds the colour nearest the anchor (in lightness, then chroma) whose EMITTED
 * HEX clears `ratio` against every surface in `against`. Returns
 * `{ hex, dL, dC, feasible }`; `feasible: false` only when even the achromatic
 * extremes fail, which for AA text against real surfaces does not happen —
 * pure black or white clears 4.5:1 against anything a UI uses as a surface.
 *
 * Order of preference:
 *   1. anchor as-is (a passing authored value is emitted unchanged),
 *   2. lightness moved outward, smallest |ΔL| first (hue + chroma untouched),
 *   3. only then chroma reduced (needed for 2 of 172 tokens in the ink split).
 */
export function solveText(anchorCss, against, { ratio = 4.5 } = {}) {
  const [L0, C0, H] = parseOklch(anchorCss);
  const surfaces = against.map(cssToHex);
  const passes = (hex) => surfaces.every((s) => contrast(hex, s) >= ratio);

  for (let scale = 1; scale >= -1e-9; scale -= 0.1) {
    const C = C0 * Math.max(0, scale);
    // Scan L outward from the anchor, both directions, nearest first.
    for (let i = 0; ; i++) {
      const up = L0 + i * L_STEP;
      const down = L0 - i * L_STEP;
      if (up > 1 + L_STEP && down < -L_STEP) break;
      for (const L of i === 0 ? [L0] : [down, up]) {
        if (L < 0 || L > 1) continue;
        const hex = toHex(oklchToSrgb([L, C, H]));
        if (passes(hex)) {
          return { hex, dL: L - L0, dC: C - C0, feasible: true };
        }
      }
    }
  }
  return { hex: toHex(oklchToSrgb([L0, C0, H])), dL: 0, dC: 0, feasible: false };
}

/**
 * Joint solve for a fill and its own -foreground.
 *
 * WHY THE FILL MAY MOVE AT ALL. A white foreground on a mid-saturation brand
 * fill (3.9:1, the most common authored defect) has no light value that clears
 * 4.5:1 — the nearest one-sided fix is near-black text, an identity flip far
 * louder than deepening the fill a step. The v0.206.7 accent repair set the
 * precedent by hand: "move the LIGHTNESS of whichever of the two shifts
 * least". This does that mechanically: scan fill ΔL outward (hue and chroma
 * pinned), give the foreground a minimal solve against each candidate, and
 * take the pair with the least total movement — fill weighted heavier, since a
 * fill repaints every component wearing it. A pair that already passes costs 0
 * and ships byte-for-byte as authored.
 */
export function solvePair(fillCss, fgAnchorCss, { ratio = 4.5, fillWeight = 1.5 } = {}) {
  const [fL, fC, fH] = parseOklch(fillCss);
  let best = null;
  for (let i = 0; i * L_STEP * 2 <= 1; i++) {
    const dLf = i * L_STEP * 2;
    if (best && fillWeight * dLf >= best.cost) break; // no candidate can win
    for (const sign of i === 0 ? [0] : [-1, 1]) {
      const L = fL + sign * dLf;
      if (L < 0 || L > 1) continue;
      const fillHex = toHex(oklchToSrgb([L, fC, fH]));
      const fg = solveText(fgAnchorCss, [fillHex], { ratio });
      if (!fg.feasible) continue;
      const cost = fillWeight * dLf + Math.abs(fg.dL) + Math.abs(fg.dC);
      if (!best || cost < best.cost) best = { fill: fillHex, fg: fg.hex, cost };
    }
  }
  if (!best) throw new Error(`no feasible pair for fill ${fillCss}`);
  return best;
}
