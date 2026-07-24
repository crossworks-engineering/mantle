'use client';

import * as React from 'react';
import { apiSend } from '@mantle/web-ui/api-fetch';
import {
  DISPLAY_FONTS,
  DEFAULT_LOGO_FONT,
  DEFAULT_TITLE_FONT,
  FONT_LOGO_STORAGE_KEY,
  FONT_TITLE_STORAGE_KEY,
  fontFamilyValue,
  fontByKey,
} from '@/lib/display-fonts';

/**
 * Wordmark + page-title font selection. Two user choices (Settings → Appearance)
 * override two CSS variables at runtime:
 *   --font-wordmark  → the header wordmark (default: the next/font Bukhari)
 *   --font-page-title → the centered header page title (default: the UI sans)
 * The header elements read them with a var() fallback, so "default" is simply
 * *not setting* the variable. Live: setting a choice repaints instantly.
 *
 * Persistence mirrors the colour theme exactly: localStorage is the before-paint
 * cache, the DB copy (profiles.preferences) is the cross-browser source of truth
 * — adopted once per shell load, written back fire-and-forget on change.
 */

const LOGO_KEY = FONT_LOGO_STORAGE_KEY;
const TITLE_KEY = FONT_TITLE_STORAGE_KEY;

type Ctx = {
  logoFont: string;
  titleFont: string;
  setLogoFont: (key: string) => void;
  setTitleFont: (key: string) => void;
  /** Apply the server-stored choices (shell load): paints + caches localStorage,
   *  never writes back — the DB copy is already the source it came from. */
  adoptServerFonts: (logo: string | null, title: string | null) => void;
};

const FontContext = React.createContext<Ctx | null>(null);

/** Set/clear a var on <html>. Default choice clears (element falls to its var()
 *  fallback); anything else sets the resolved font-family value. Unknown keys
 *  clear too, so a key removed from the registry never strands the wordmark. */
function applyVar(prop: string, key: string, defaultKey: string) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const value = key === defaultKey ? null : fontFamilyValue(key);
  if (value) root.style.setProperty(prop, value);
  else root.style.removeProperty(prop);
}

function apply(logo: string, title: string) {
  applyVar('--font-wordmark', logo, DEFAULT_LOGO_FONT);
  applyVar('--font-page-title', title, DEFAULT_TITLE_FONT);
}

function readStored(key: string, fallback: string): string {
  try {
    const v = window.localStorage.getItem(key);
    return v && fontByKey(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function cache(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked — preference won't persist, no-op */
  }
}

export function FontProvider({ children }: { children: React.ReactNode }) {
  const [logoFont, setLogoState] = React.useState(DEFAULT_LOGO_FONT);
  const [titleFont, setTitleState] = React.useState(DEFAULT_TITLE_FONT);

  // Before-paint cache: adopt this browser's last choice on mount.
  React.useEffect(() => {
    const logo = readStored(LOGO_KEY, DEFAULT_LOGO_FONT);
    const title = readStored(TITLE_KEY, DEFAULT_TITLE_FONT);
    setLogoState(logo);
    setTitleState(title);
    apply(logo, title);
  }, []);

  const persist = React.useCallback((body: { fontLogo?: string; fontTitle?: string }) => {
    // The DB copy is the cross-browser source of truth; localStorage above is
    // the pre-paint cache. Fire-and-forget — a failed write costs only the sync.
    void apiSend('/api/profile/fonts', 'PUT', body).catch(() => {});
  }, []);

  // Each setter touches ONLY its own var + persists ONLY its own field — no
  // dependence on the other font's state. (A combined apply() reading the other
  // choice from a closure could revert it when both change before a re-render.)
  const setLogoFont = React.useCallback(
    (key: string) => {
      if (!fontByKey(key)) return;
      setLogoState(key);
      applyVar('--font-wordmark', key, DEFAULT_LOGO_FONT);
      cache(LOGO_KEY, key);
      persist({ fontLogo: key });
    },
    [persist],
  );

  const setTitleFont = React.useCallback(
    (key: string) => {
      if (!fontByKey(key)) return;
      setTitleState(key);
      applyVar('--font-page-title', key, DEFAULT_TITLE_FONT);
      cache(TITLE_KEY, key);
      persist({ fontTitle: key });
    },
    [persist],
  );

  // Adopt the DB copy (cross-browser source of truth) — but ONLY for a field the
  // server actually has. A null means "never saved": keep this browser's choice
  // (the pre-paint script already applied it from localStorage) rather than
  // forcing the default and clobbering it. Mirrors the colour theme's guard
  // (`if (!stored) return`). Without this, a brain whose backend predates this
  // feature — or a user who's only ever set fonts on ONE browser — would have
  // their local choice wiped on every shell load.
  const adoptServerFonts = React.useCallback((logo: string | null, title: string | null) => {
    if (logo && fontByKey(logo)) {
      setLogoState(logo);
      applyVar('--font-wordmark', logo, DEFAULT_LOGO_FONT);
      cache(LOGO_KEY, logo);
    }
    if (title && fontByKey(title)) {
      setTitleState(title);
      applyVar('--font-page-title', title, DEFAULT_TITLE_FONT);
      cache(TITLE_KEY, title);
    }
  }, []);

  const value = React.useMemo(
    () => ({ logoFont, titleFont, setLogoFont, setTitleFont, adoptServerFonts }),
    [logoFont, titleFont, setLogoFont, setTitleFont, adoptServerFonts],
  );

  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}

export function useFonts() {
  const ctx = React.useContext(FontContext);
  if (!ctx) throw new Error('useFonts must be used within FontProvider');
  return ctx;
}

/** The full offered list — re-exported so pickers don't import the registry
 *  directly (keeps the provider the one UI-facing seam). */
export { DISPLAY_FONTS };
