/**
 * Color-theme registry. Generated from tweakcn's theme presets
 * (utils/theme-presets.ts). 'clean-slate' is the baseline and lives
 * directly in :root / .dark in globals.css; every other theme is a
 * `[data-color-theme="<id>"]` override block in globals.css.
 *
 * Swatches ([primary, accent, background], light mode) drive the picker
 * preview only.
 */
export type ColorTheme = {
  id: string;
  label: string;
  swatches: [string, string, string];
};

export const COLOR_THEMES: ColorTheme[] = [
  { id: "clean-slate", label: "Clean Slate", swatches: ["#6366f1", "#e0e7ff", "#f8fafc"] },
  { id: "amber-minimal", label: "Amber Minimal", swatches: ["#f59e0b", "#fffbeb", "#ffffff"] },
  { id: "amethyst-haze", label: "Amethyst Haze", swatches: ["#8a79ab", "#e6a5b8", "#f8f7fa"] },
  { id: "bold-tech", label: "Bold Tech", swatches: ["#8b5cf6", "#dbeafe", "#ffffff"] },
  { id: "bubblegum", label: "Bubblegum", swatches: ["#d04f99", "#fbe2a7", "#f6e6ee"] },
  { id: "caffeine", label: "Caffeine", swatches: ["#644a40", "#e8e8e8", "#f9f9f9"] },
  { id: "candyland", label: "Candyland", swatches: ["#ffc0cb", "#ffff00", "#f7f9fa"] },
  { id: "catppuccin", label: "Catppuccin", swatches: ["#8839ef", "#04a5e5", "#eff1f5"] },
  { id: "claude", label: "Claude", swatches: ["#c96442", "#e9e6dc", "#faf9f5"] },
  { id: "claymorphism", label: "Claymorphism", swatches: ["#6366f1", "#f3e5f5", "#e7e5e4"] },
  { id: "cosmic-night", label: "Cosmic Night", swatches: ["#6e56cf", "#d8e6ff", "#f5f5ff"] },
  { id: "cyberpunk", label: "Cyberpunk", swatches: ["#ff00c8", "#00ffcc", "#f8f9fa"] },
  { id: "darkmatter", label: "Darkmatter", swatches: ["#d87943", "#eeeeee", "#ffffff"] },
  { id: "doom-64", label: "Doom 64", swatches: ["#b71c1c", "#4682b4", "#cccccc"] },
  { id: "elegant-luxury", label: "Elegant Luxury", swatches: ["#9b2c2c", "#fef3c7", "#faf7f5"] },
  { id: "graphite", label: "Graphite", swatches: ["#606060", "#c0c0c0", "#f0f0f0"] },
  { id: "kodama-grove", label: "Kodama Grove", swatches: ["#8d9d4f", "#dbc894", "#e4d7b0"] },
  { id: "midnight-bloom", label: "Midnight Bloom", swatches: ["#6c5ce7", "#8b9467", "#f9f9f9"] },
  { id: "mocha-mousse", label: "Mocha Mousse", swatches: ["#A37764", "#E4C7B8", "#F1F0E5"] },
  { id: "modern-minimal", label: "Modern Minimal", swatches: ["#3b82f6", "#e0f2fe", "#ffffff"] },
  { id: "mono", label: "Mono", swatches: ["#737373", "#f5f5f5", "#ffffff"] },
  { id: "nature", label: "Nature", swatches: ["#2e7d32", "#c8e6c9", "#f8f5f0"] },
  { id: "neo-brutalism", label: "Neo Brutalism", swatches: ["#ff3333", "#0066ff", "#ffffff"] },
  { id: "northern-lights", label: "Northern Lights", swatches: ["#34a85a", "#66d9ef", "#f9f9fa"] },
  { id: "notebook", label: "Notebook", swatches: ["#606060", "#f3eac8", "#f9f9f9"] },
  { id: "ocean-breeze", label: "Ocean Breeze", swatches: ["#22c55e", "#d1fae5", "#f0f8ff"] },
  { id: "pastel-dreams", label: "Pastel Dreams", swatches: ["#a78bfa", "#f3e5f5", "#f7f3f9"] },
  { id: "perpetuity", label: "Perpetuity", swatches: ["#06858e", "#c9e5e7", "#e8f0f0"] },
  { id: "quantum-rose", label: "Quantum Rose", swatches: ["#e6067a", "#ffc1e3", "#fff0f8"] },
  { id: "retro-arcade", label: "Retro Arcade", swatches: ["#d33682", "#cb4b16", "#fdf6e3"] },
  { id: "sage-garden", label: "Sage Garden", swatches: ["#7c9082", "#bfc9bb", "#f8f7f4"] },
  { id: "soft-pop", label: "Soft Pop", swatches: ["#4f46e5", "#f59e0b", "#f7f9f3"] },
  { id: "solar-dusk", label: "Solar Dusk", swatches: ["#B45309", "#f2daba", "#FDFBF7"] },
  { id: "starry-night", label: "Starry Night", swatches: ["#3a5ba0", "#6ea3c1", "#f5f7fa"] },
  { id: "sunset-horizon", label: "Sunset Horizon", swatches: ["#ff7e5f", "#feb47b", "#fff9f5"] },
  { id: "supabase", label: "Supabase", swatches: ["#72e3ad", "#ededed", "#fcfcfc"] },
  { id: "t3-chat", label: "T3 Chat", swatches: ["#a84370", "#f1c4e6", "#faf5fa"] },
  { id: "tangerine", label: "Tangerine", swatches: ["#e05d38", "#d6e4f0", "#e8ebed"] },
  { id: "twitter", label: "Twitter", swatches: ["#1e9df1", "#E3ECF6", "#ffffff"] },
  { id: "vercel", label: "Vercel", swatches: ["oklch(0 0 0)", "oklch(0.94 0 0)", "oklch(0.99 0 0)"] },
  { id: "vintage-paper", label: "Vintage Paper", swatches: ["#a67c52", "#d4c8aa", "#f5f1e6"] },
  { id: "violet-bloom", label: "Violet Bloom", swatches: ["#7033ff", "#e2ebff", "#fdfdfd"] },
];

export const DEFAULT_COLOR_THEME = 'clean-slate';
export const COLOR_THEME_STORAGE_KEY = 'mantle-color-theme';
/** Whether "random theme" mode (reshuffle on a timer) is on. */
export const RANDOM_THEME_STORAGE_KEY = 'mantle-random-theme';
/** Epoch-ms of the last random reshuffle, so the timer survives reloads. */
export const RANDOM_THEME_AT_STORAGE_KEY = 'mantle-random-theme-at';
/** How often random-theme mode reshuffles: every 12 hours. */
export const RANDOM_THEME_INTERVAL_MS = 12 * 60 * 60 * 1000;

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
