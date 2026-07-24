/**
 * Aside — gradient styling helpers (the single source of truth for how an aside
 * box is painted). Shared by the live editor NodeView (`aside-view.tsx`) and the
 * server-side public renderer (`lib/render-page-doc.ts`) so an aside looks the
 * same in both. Framework-free + pure (the random pickers run client-side only,
 * on slash-insert / swatch-click), so this module is safe to import from a
 * server file.
 *
 * The gradient is built from a SELECTED themed colour (`chart-1..5`, never a raw
 * hex — themes redefine these vars) plus an `angle`. It blends the base colour
 * into the cyclically-next chart colour and layers a soft radial glow whose
 * corner tracks the angle, so each aside reads as a distinct, on-theme panel.
 */

export const ASIDE_COLORS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
export type AsideColor = (typeof ASIDE_COLORS)[number];

export const DEFAULT_ASIDE_COLOR: AsideColor = 'chart-1';
export const DEFAULT_ASIDE_ANGLE = 135;

export function normalizeAsideColor(v: unknown): AsideColor {
  return (ASIDE_COLORS as readonly string[]).includes(v as string)
    ? (v as AsideColor)
    : DEFAULT_ASIDE_COLOR;
}

/** Wrap any value into a clean 0–359 integer angle. */
export function normalizeAsideAngle(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_ASIDE_ANGLE;
  return ((n % 360) + 360) % 360;
}

/** The cyclically-next chart colour — the gradient's second stop. */
function secondaryColor(color: AsideColor): AsideColor {
  const i = ASIDE_COLORS.indexOf(color);
  return ASIDE_COLORS[(i + 1) % ASIDE_COLORS.length]!;
}

const RADIAL_CORNERS = ['top left', 'top right', 'bottom right', 'bottom left'] as const;

/**
 * The full `background` shorthand for an aside: a soft radial glow (corner
 * derived from the angle) layered over a directional two-tone wash. Uses
 * `color-mix` + theme vars so it tracks the active theme and light/dark.
 */
export function asideBackground(color: AsideColor, angle: number): string {
  const a = normalizeAsideAngle(angle);
  const c1 = `var(--${color})`;
  const c2 = `var(--${secondaryColor(color)})`;
  const corner = RADIAL_CORNERS[Math.floor(a / 90) % 4]!;
  const radial = `radial-gradient(circle at ${corner}, color-mix(in oklab, ${c2} 22%, transparent), transparent 62%)`;
  const linear = `linear-gradient(${a}deg, color-mix(in oklab, ${c1} 16%, transparent), color-mix(in oklab, ${c2} 7%, transparent))`;
  return `${radial}, ${linear}`;
}

/** A faint themed border that pairs with the gradient fill. */
export function asideBorderColor(color: AsideColor): string {
  return `color-mix(in oklab, var(--${color}) 30%, transparent)`;
}

/** Random themed colour — used when inserting a fresh aside (client-side only). */
export function randomAsideColor(): AsideColor {
  return ASIDE_COLORS[Math.floor(Math.random() * ASIDE_COLORS.length)]!;
}

/** Random gradient angle — used when inserting / reshuffling (client-side only). */
export function randomAsideAngle(): number {
  return Math.floor(Math.random() * 360);
}
