'use client';

import * as React from 'react';
import {
  COLOR_THEME_STORAGE_KEY,
  DEFAULT_COLOR_THEME,
} from '@/lib/themes';

type Ctx = {
  colorTheme: string;
  setColorTheme: (id: string) => void;
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

  React.useEffect(() => {
    const stored =
      (typeof window !== 'undefined' &&
        window.localStorage.getItem(COLOR_THEME_STORAGE_KEY)) ||
      DEFAULT_COLOR_THEME;
    setColorThemeState(stored);
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

  return (
    <ColorThemeContext.Provider value={{ colorTheme, setColorTheme }}>
      {children}
    </ColorThemeContext.Provider>
  );
}

export function useColorTheme() {
  const ctx = React.useContext(ColorThemeContext);
  if (!ctx) throw new Error('useColorTheme must be used within ColorThemeProvider');
  return ctx;
}
