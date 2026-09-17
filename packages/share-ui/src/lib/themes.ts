/**
 * Color-theme registry. The theme LIST is generated — `themes/seeds.mjs` is
 * the authored source, `pnpm themes:build` regenerates both the CSS and
 * `theme-registry.gen.ts`, and the drift test keeps them in lockstep. This
 * module owns the TYPE, the default, and the random-theme behaviour toggles.
 *
 * Swatches ([primary, accent, background], per mode) drive the picker preview
 * only. Both modes ship because the picker sits inside the app it is theming:
 * showing light-mode dots to someone browsing in dark mode advertises colours
 * they would not get.
 */
export type ThemeSwatches = readonly [string, string, string];

export type ColorTheme = {
  id: string;
  label: string;
  swatches: { light: ThemeSwatches; dark: ThemeSwatches };
};

import { GENERATED_COLOR_THEMES } from './theme-registry.gen';

export const COLOR_THEMES: ColorTheme[] = GENERATED_COLOR_THEMES;

export const DEFAULT_COLOR_THEME = 'clean-slate';

/** The human label for a theme id — one spelling of a theme's name across the
 *  whole product. Falls back to the id so an unknown/retired id still reads. */
export function themeLabel(id: string): string {
  return COLOR_THEMES.find((t) => t.id === id)?.label ?? id;
}

// (No storage key for the theme itself: the choice lives on the anchor
// owner's profile row and is server-rendered into <html data-color-theme> —
// see @mantle/web-ui/appearance. The RANDOM_* keys below are genuinely
// visitor-local behavior toggles, so localStorage remains right for them.)
/** Whether "random theme" mode (reshuffle on a timer) is on. */
export const RANDOM_THEME_STORAGE_KEY = 'mantle-random-theme';
/** Epoch-ms of the last random reshuffle, so the timer survives reloads. */
export const RANDOM_THEME_AT_STORAGE_KEY = 'mantle-random-theme-at';
/** Chosen reshuffle cadence, in ms (one of RANDOM_THEME_INTERVALS). */
export const RANDOM_THEME_INTERVAL_STORAGE_KEY = 'mantle-random-theme-interval';

const HOUR_MS = 60 * 60 * 1000;

/** Selectable reshuffle cadences for random-theme mode (the dice menu). */
export const RANDOM_THEME_INTERVALS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: HOUR_MS, label: 'Every hour' },
  { ms: 6 * HOUR_MS, label: 'Every 6 hours' },
  { ms: 12 * HOUR_MS, label: 'Every 12 hours' },
  { ms: 24 * HOUR_MS, label: 'Every day' },
  { ms: 7 * 24 * HOUR_MS, label: 'Every week' },
];

/** Default cadence (12 hours) — used when nothing valid is stored. */
export const RANDOM_THEME_INTERVAL_MS = 12 * HOUR_MS;

/** Coerce a stored interval string to a known cadence, else the default. */
export function coerceRandomInterval(raw: string | null): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && RANDOM_THEME_INTERVALS.some((i) => i.ms === n)
    ? n
    : RANDOM_THEME_INTERVAL_MS;
}

/**
 * Pick a random color-theme id, avoiding `exclude` (the current one) so a
 * reshuffle always visibly changes something. Falls back to the full list if
 * excluding leaves nothing.
 */
export function pickRandomColorTheme(exclude?: string): string {
  const pool = COLOR_THEMES.filter((t) => t.id !== exclude);
  const list = pool.length > 0 ? pool : COLOR_THEMES;
  const picked = list[Math.floor(Math.random() * list.length)] ?? list[0]!;
  return picked.id;
}
