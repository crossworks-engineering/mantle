'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import {
  COLOR_THEME_STORAGE_KEY,
  RANDOM_THEME_STORAGE_KEY,
  DEFAULT_COLOR_THEME,
  pickRandomColorTheme,
} from '@/lib/themes';

type Ctx = {
  colorTheme: string;
  setColorTheme: (id: string) => void;
  /** When on, the color theme reshuffles to a random one on every navigation. */
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

export function ColorThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorTheme, setColorThemeState] = React.useState(DEFAULT_COLOR_THEME);
  const [randomTheme, setRandomThemeState] = React.useState(false);
  const pathname = usePathname();

  // Live refs so the navigation effect can read current values without
  // re-subscribing (it must fire on *pathname* change only — not whenever the
  // theme or the toggle changes, or it would double-shuffle).
  const colorThemeRef = React.useRef(colorTheme);
  colorThemeRef.current = colorTheme;
  const randomRef = React.useRef(randomTheme);
  randomRef.current = randomTheme;

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
      // Enabling jumps to a fresh theme right away (immediate feedback that it's
      // on); disabling does nothing, so it sticks to the last theme.
      if (on) setColorTheme(pickRandomColorTheme(colorThemeRef.current));
    },
    [setColorTheme],
  );

  // Reshuffle on every navigation ("menu click") while enabled. The first run
  // is the initial mount — skip it so a reload keeps the last theme until you
  // actually navigate.
  const firstNav = React.useRef(true);
  React.useEffect(() => {
    if (firstNav.current) {
      firstNav.current = false;
      return;
    }
    if (!randomRef.current) return;
    setColorTheme(pickRandomColorTheme(colorThemeRef.current));
  }, [pathname, setColorTheme]);

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
