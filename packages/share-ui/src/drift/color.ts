/**
 * Colour plumbing for Drift: CSS colour → linear sRGB → OKLab, the space the
 * shader blends in.
 *
 * Why OKLab: an sRGB lerp between two saturated colours sags through a muddy,
 * darker midpoint (blue → orange crosses grey). OKLab is perceptually uniform,
 * so a blend keeps its lightness and chroma and the gradient reads luminous
 * rather than dirty. It is the single biggest visual difference from Neat.
 */

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

/** Parse #rgb / #rrggbb / #rrggbbaa / rgb() / rgba(). Null on anything else. */
export function parseHexOrRgb(input: string): Rgb | null {
  const t = input.trim().toLowerCase();
  // Shorthand MUST parse: minified stylesheets shorten tokens (#ffffff → #fff),
  // and getComputedStyle hands back exactly that on deployed builds.
  const short = /^#([0-9a-f]{3})$/.exec(t)?.[1];
  if (short) {
    const c = (i: number) => parseInt(short.charAt(i) + short.charAt(i), 16);
    return [c(0), c(1), c(2)];
  }
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(t)?.[1];
  if (long) {
    const n = parseInt(long, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(t);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * Any CSS colour (oklch(), hsl(), named…) → sRGB bytes. Hex and rgb() take the
 * fast path; the rest are normalised by a 1×1 2D canvas, which speaks every
 * colour syntax the browser does. Null when the string is not a colour.
 */
export function parseColor(input: string): Rgb | null {
  const fast = parseHexOrRgb(input);
  if (fast) return fast;
  if (typeof document === 'undefined') return null;
  if (probe === undefined) {
    probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  }
  if (!probe) return null;
  // A sentinel first, so an unparseable string (which leaves fillStyle alone)
  // is detected instead of returning the previous colour.
  probe.fillStyle = '#010203';
  probe.fillStyle = input;
  if (probe.fillStyle === '#010203' && !/^#010203$/i.test(input.trim())) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** sRGB bytes → OKLab (Björn Ottosson's published matrices). */
export function rgbToOklab([r8, g8, b8]: Rgb): Lab {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → sRGB bytes, gamut-clipped. */
export function oklabToRgb([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** OKLab mix: 0 keeps `from`, 1 lands on `to`. */
export function mixLab(from: Lab, to: Lab, t: number): Lab {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}
