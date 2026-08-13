/** Hand-written declarations for seeds.mjs. */
export type ThemeModeSeed = {
  charts?: string[];
  extras?: Record<string, string>;
} & {
  [token: string]: string | string[] | Record<string, string> | undefined;
};

export interface ThemeSeed {
  id: string;
  label: string;
  light: ThemeModeSeed;
  dark: ThemeModeSeed;
}

export const THEME_SEEDS: ThemeSeed[];
