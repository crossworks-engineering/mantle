/**
 * Color-theme registry. Each theme is a token set generated with
 * tweakcn.com. "clean-slate" is the baseline and lives directly in
 * :root / .dark in globals.css (no data-attribute override needed).
 *
 * To add a theme:
 *   1. In globals.css add `[data-color-theme="<id>"] { …light tokens… }`
 *      and `[data-color-theme="<id>"].dark { …dark tokens… }`.
 *   2. Add an entry below with a few representative swatches (oklch).
 *
 * The swatches are only used to render the picker preview.
 */
export type ColorTheme = {
  id: string;
  label: string;
  /** Light-mode preview swatches: [primary, accent, background]. */
  swatches: [string, string, string];
};

export const COLOR_THEMES: ColorTheme[] = [
  {
    id: 'clean-slate',
    label: 'Clean Slate',
    swatches: [
      'oklch(0.5854 0.2041 277.1173)',
      'oklch(0.9299 0.0334 272.7879)',
      'oklch(0.9842 0.0034 247.8575)',
    ],
  },
];

export const DEFAULT_COLOR_THEME = 'clean-slate';
export const COLOR_THEME_STORAGE_KEY = 'mantle-color-theme';
