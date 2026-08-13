/** Hand-written declarations for model.mjs (plain JS so `node` runs it at
 *  build time with no transpile step; typecheck still sees real shapes). */
export function parseColor(value: string): [number, number, number];
export function oklchToSrgb(lch: [number, number, number]): [number, number, number];
export function srgbToOklab(rgb: [number, number, number]): [number, number, number];
export function srgbToOklch(rgb: [number, number, number]): [number, number, number];
export function parseOklch(css: string): [number, number, number];
export function toHex(rgb: [number, number, number]): string;
export function cssToHex(css: string): string;
export function luminance(rgb: [number, number, number]): number;
export function contrast(cssA: string, cssB: string): number;
export function deltaE(cssA: string, cssB: string): number;
export function hueDistance(a: number, b: number): number;
export const clamp01: (x: number) => number;
export function solveText(
  anchorCss: string,
  against: readonly string[],
  opts?: { ratio?: number },
): { hex: string; dL: number; dC: number; feasible: boolean };
export function solvePair(
  fillCss: string,
  fgAnchorCss: string,
  opts?: { ratio?: number; fillWeight?: number },
): { fill: string; fg: string; cost: number };
