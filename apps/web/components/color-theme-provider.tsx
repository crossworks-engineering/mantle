'use client';

import * as React from 'react';
import {
  COLOR_THEME_STORAGE_KEY,
  RANDOM_THEME_STORAGE_KEY,
  RANDOM_THEME_AT_STORAGE_KEY,
  RANDOM_THEME_INTERVAL_STORAGE_KEY,
  RANDOM_THEME_INTERVAL_MS,
  DEFAULT_COLOR_THEME,
  coerceRandomInterval,
  pickRandomColorTheme,
} from '@/lib/themes';

type Ctx = {
  colorTheme: string;
  setColorTheme: (id: string) => void;
  /** When on, the color theme reshuffles to a random one every `intervalMs`. */
  randomTheme: boolean;
  setRandomTheme: (on: boolean) => void;
  /** Chosen reshuffle cadence in ms. */
  intervalMs: number;
  setIntervalMs: (ms: number) => void;
  /** Reshuffle right now (one-off) and reset the cadence clock. */
  shuffleNow: () => void;
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

function writeShuffledAt(ms: number) {
  try {
    window.localStorage.setItem(RANDOM_THEME_AT_STORAGE_KEY, String(ms));
  } catch {
    // storage blocked — timer won't survive reloads, no-op
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

export function ColorThemeProvider({ children }: { children: React.ReactNode }) {
  const [colorTheme, setColorThemeState] = React.useState(DEFAULT_COLOR_THEME);
  const [randomTheme, setRandomThemeState] = React.useState(false);
  const [intervalMs, setIntervalMsState] = React.useState(RANDOM_THEME_INTERVAL_MS);
  // Bumped by an external one-off shuffle so the timer effect reschedules from
  // the new timestamp (auto-ticks reschedule themselves and don't bump this).
  const [rescheduleNonce, setRescheduleNonce] = React.useState(0);

  // Live ref so the timer can reshuffle relative to the current theme without
  // re-subscribing every time the theme changes.
  const colorThemeRef = React.useRef(colorTheme);
  colorThemeRef.current = colorTheme;

  React.useEffect(() => {
    let stored = DEFAULT_COLOR_THEME;
    let random = false;
    let interval = RANDOM_THEME_INTERVAL_MS;
    try {
      stored = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY) || DEFAULT_COLOR_THEME;
      random = window.localStorage.getItem(RANDOM_THEME_STORAGE_KEY) === '1';
      interval = coerceRandomInterval(
        window.localStorage.getItem(RANDOM_THEME_INTERVAL_STORAGE_KEY),
      );
    } catch {
      // storage blocked — fall back to defaults
    }
    setColorThemeState(stored);
    setRandomThemeState(random);
    setIntervalMsState(interval);
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
      // starts the clock; disabling does nothing, so it sticks to the last
      // theme.
      if (on) {
        setColorTheme(pickRandomColorTheme(colorThemeRef.current));
        writeShuffledAt(Date.now());
      }
    },
    [setColorTheme],
  );

  const setIntervalMs = React.useCallback((ms: number) => {
    setIntervalMsState(ms);
    try {
      window.localStorage.setItem(RANDOM_THEME_INTERVAL_STORAGE_KEY, String(ms));
    } catch {
      // storage blocked — preference won't persist, no-op
    }
  }, []);

  const shuffleNow = React.useCallback(() => {
    setColorTheme(pickRandomColorTheme(colorThemeRef.current));
    writeShuffledAt(Date.now());
    setRescheduleNonce((n) => n + 1);
  }, [setColorTheme]);

  // While enabled, reshuffle every `intervalMs`. The timestamp is persisted, so
  // the schedule survives reloads and closed periods: on load we catch up if
  // the interval already lapsed, otherwise we wait out the remainder. A reload
  // that isn't yet due keeps the last theme.
  React.useEffect(() => {
    if (!randomTheme) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setColorTheme(pickRandomColorTheme(colorThemeRef.current));
      writeShuffledAt(Date.now());
      timer = setTimeout(tick, intervalMs);
    };
    const last = readShuffledAt() ?? Date.now();
    const remaining = last + intervalMs - Date.now();
    if (remaining <= 0) tick();
    else timer = setTimeout(tick, remaining);
    return () => clearTimeout(timer);
  }, [randomTheme, intervalMs, rescheduleNonce, setColorTheme]);

  return (
    <ColorThemeContext.Provider
      value={{
        colorTheme,
        setColorTheme,
        randomTheme,
        setRandomTheme,
        intervalMs,
        setIntervalMs,
        shuffleNow,
      }}
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
