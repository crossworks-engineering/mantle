'use client';

import * as React from 'react';
import {
  COLOR_THEME_STORAGE_KEY,
  RANDOM_THEME_STORAGE_KEY,
  RANDOM_THEME_AT_STORAGE_KEY,
  RANDOM_THEME_INTERVAL_MS,
  DEFAULT_COLOR_THEME,
  pickRandomColorTheme,
} from '@/lib/themes';

type Ctx = {
  colorTheme: string;
  setColorTheme: (id: string) => void;
  /** When on, the color theme reshuffles to a random one every 12 hours. */
  randomTheme: boolean;
  setRandomTheme: (on: boolean) => void;
};

const ColorThemeContext = React.createContext<Ctx | null>(null);

function apply(id: string) {
  if (typeof document === 'undefined') return;
  if (id === DEFAULT_COLOR_THEME) {
    delete document.documentElement.dataset.colorTheme;
  } else {
    document.documentElement.dataset.colorTheme = id;
  }
}

function readShuffledAt(): number | null {
  try {
    const raw = window.localStorage.getItem(RANDOM_THEME_AT_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeShuffledAt(ms: number) {
  try {
    window.localStorage.setItem(RANDOM_THEME_AT_STORAGE_KEY, String(ms));
  } catch {
    // storage blocked — timer won't survive reloads, no-op
  }
}

export function ColorThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorTheme, setColorThemeState] = React.useState(DEFAULT_COLOR_THEME);
  const [randomTheme, setRandomThemeState] = React.useState(false);

  // Live ref so the timer can reshuffle relative to the current theme without
  // re-subscribing every time the theme changes.
  const colorThemeRef = React.useRef(colorTheme);
  colorThemeRef.current = colorTheme;

  React.useEffect(() => {
    let stored = DEFAULT_COLOR_THEME;
    let random = false;
    try {
      stored = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY) || DEFAULT_COLOR_THEME;
      random = window.localStorage.getItem(RANDOM_THEME_STORAGE_KEY) === '1';
    } catch {
      // storage blocked — fall back to defaults
    }
    setColorThemeState(stored);
    setRandomThemeState(random);
    apply(stored);
  }, []);

  const setColorTheme = React.useCallback((id: string) => {
    setColorThemeState(id);
    apply(id);
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, id);
    } catch {
      // storage blocked — preference won't persist, no-op
    }
  }, []);

  const setRandomTheme = React.useCallback(
    (on: boolean) => {
      setRandomThemeState(on);
      try {
        window.localStorage.setItem(RANDOM_THEME_STORAGE_KEY, on ? '1' : '0');
      } catch {
        // storage blocked — preference won't persist, no-op
      }
      // Enabling jumps to a fresh theme right away (immediate feedback) and
      // starts the 12h clock; disabling does nothing, so it sticks to the last
      // theme.
      if (on) {
        setColorTheme(pickRandomColorTheme(colorThemeRef.current));
        writeShuffledAt(Date.now());
      }
    },
    [setColorTheme],
  );

  // While enabled, reshuffle every 12h. The timestamp is persisted, so the
  // schedule survives reloads and closed periods: on load we catch up if the
  // interval already lapsed, otherwise we wait out the remainder. A reload that
  // isn't yet due keeps the last theme.
  React.useEffect(() => {
    if (!randomTheme) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setColorTheme(pickRandomColorTheme(colorThemeRef.current));
      writeShuffledAt(Date.now());
      timer = setTimeout(tick, RANDOM_THEME_INTERVAL_MS);
    };
    const last = readShuffledAt() ?? Date.now();
    const remaining = last + RANDOM_THEME_INTERVAL_MS - Date.now();
    if (remaining <= 0) tick();
    else timer = setTimeout(tick, remaining);
    return () => clearTimeout(timer);
  }, [randomTheme, setColorTheme]);

  return (
    <ColorThemeContext.Provider
      value={{ colorTheme, setColorTheme, randomTheme, setRandomTheme }}
    >
      {children}
    </ColorThemeContext.Provider>
  );
}

export function useColorTheme() {
  const ctx = React.useContext(ColorThemeContext);
  if (!ctx) throw new Error('useColorTheme must be used within ColorThemeProvider');
  return ctx;
}
