'use client';

import * as React from 'react';
import { apiSend } from '@mantle/web-ui/api-fetch';
import {
  DISPLAY_FONTS,
  UI_FONTS,
  DEFAULT_LOGO_FONT,
  DEFAULT_TITLE_FONT,
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  fontFamilyValue,
  fontByKey,
  resolveUiFontSize,
  type UiFontSize,
} from './display-fonts';

/**
 * Typography selection — the two display faces, the INTERFACE font, and the UI
 * scale. Admin choices (Settings → Appearance) override CSS variables at
 * runtime:
 *   --font-wordmark   → the header wordmark (default: the next/font Bukhari)
 *   --font-page-title → the centered header page title (default: the UI sans)
 *   --font-sans       → the whole interface (default: the next/font Inter)
 * plus `data-font-size` on <html>, which app.css turns into a root font-size.
 * The header elements read them with a var() fallback, so "default" is simply
 * *not setting* the variable. Live: setting a choice repaints instantly.
 *
 * Persistence mirrors the colour theme exactly: the DB copy
 * (profiles.preferences on the anchor owner) is the source of truth, rendered
 * server-side into `<html data-font-logo/-title>` + the inline style vars
 * (see @mantle/web-ui/appearance) — the document arrives painted; this
 * provider reads the attributes back on mount and writes changes through
 * fire-and-forget.
 */

type Ctx = {
  logoFont: string;
  titleFont: string;
  uiFont: string;
  fontSize: UiFontSize;
  setLogoFont: (key: string) => void;
  setTitleFont: (key: string) => void;
  setUiFont: (key: string) => void;
  setFontSize: (size: UiFontSize) => void;
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

/** Mirror a chosen key into the <html> dataset (default clears the attribute,
 *  matching the server render, where "default" is the attribute's absence). */
function syncAttr(
  prop: 'fontLogo' | 'fontTitle' | 'fontUi' | 'fontSize',
  key: string,
  defaultKey: string,
) {
  if (typeof document === 'undefined') return;
  const d = document.documentElement.dataset;
  if (key === defaultKey) delete d[prop];
  else d[prop] = key;
}

/** Read a server-rendered key attribute off <html>, falling back to the
 *  default when absent or unknown (a key removed from the registry must not
 *  become picker state). */
function readAttr(value: string | undefined, fallback: string): string {
  return value && fontByKey(value) ? value : fallback;
}

export function FontProvider({ children }: { children: React.ReactNode }) {
  const [logoFont, setLogoState] = React.useState(DEFAULT_LOGO_FONT);
  const [titleFont, setTitleState] = React.useState(DEFAULT_TITLE_FONT);
  const [uiFont, setUiState] = React.useState(DEFAULT_UI_FONT);
  const [fontSize, setSizeState] = React.useState<UiFontSize>(DEFAULT_UI_FONT_SIZE);

  // The document arrived with the brain's fonts already rendered (attributes +
  // inline vars, server-side). Read the attributes back as initial state — no
  // repaint needed, the DOM is already correct.
  React.useEffect(() => {
    const d = document.documentElement.dataset;
    setLogoState(readAttr(d.fontLogo, DEFAULT_LOGO_FONT));
    setTitleState(readAttr(d.fontTitle, DEFAULT_TITLE_FONT));
    setUiState(readAttr(d.fontUi, DEFAULT_UI_FONT));
    setSizeState(resolveUiFontSize(d.fontSize));
  }, []);

  const persist = React.useCallback(
    (body: { fontLogo?: string; fontTitle?: string; fontUi?: string; fontSize?: string }) => {
      // The DB copy is the cross-browser source of truth; localStorage above is
      // the pre-paint cache. Fire-and-forget — a failed write costs only the sync.
      void apiSend('/api/profile/fonts', 'PUT', body).catch(() => {});
    },
    [],
  );

  // Each setter touches ONLY its own var + persists ONLY its own field — no
  // dependence on the other font's state. (A combined apply() reading the other
  // choice from a closure could revert it when both change before a re-render.)
  // The dataset key is kept in sync with the style var so the DOM stays
  // self-consistent with what the server would have rendered.
  const setLogoFont = React.useCallback(
    (key: string) => {
      if (!fontByKey(key)) return;
      setLogoState(key);
      applyVar('--font-wordmark', key, DEFAULT_LOGO_FONT);
      syncAttr('fontLogo', key, DEFAULT_LOGO_FONT);
      persist({ fontLogo: key });
    },
    [persist],
  );

  const setTitleFont = React.useCallback(
    (key: string) => {
      if (!fontByKey(key)) return;
      setTitleState(key);
      applyVar('--font-page-title', key, DEFAULT_TITLE_FONT);
      syncAttr('fontTitle', key, DEFAULT_TITLE_FONT);
      persist({ fontTitle: key });
    },
    [persist],
  );

  // The interface font overrides `--font-sans` itself, so every element that
  // resolves it — the `font-sans` utility and everything inheriting from the
  // root — follows with no further wiring. It lands on <html>, the same element
  // next/font's variable CLASS sits on, because inline style beats a class only
  // on the same element.
  const setUiFont = React.useCallback(
    (key: string) => {
      if (!fontByKey(key)) return;
      setUiState(key);
      applyVar('--font-sans', key, DEFAULT_UI_FONT);
      syncAttr('fontUi', key, DEFAULT_UI_FONT);
      persist({ fontUi: key });
    },
    [persist],
  );

  const setFontSize = React.useCallback(
    (size: UiFontSize) => {
      const resolved = resolveUiFontSize(size);
      setSizeState(resolved);
      // No var: app.css keys the root font-size off the attribute, so the
      // cascade does the scaling and there is nothing to recompute here.
      syncAttr('fontSize', resolved, DEFAULT_UI_FONT_SIZE);
      persist({ fontSize: resolved });
    },
    [persist],
  );

  // Live sync from /api/shell (another browser changed the brain's fonts mid-
  // session) — adopt ONLY fields the server actually has. A null means "never
  // saved": the server-rendered document already reflects that (no attribute),
  // so there is nothing to undo.
  const adoptServerFonts = React.useCallback((logo: string | null, title: string | null) => {
    if (logo && fontByKey(logo)) {
      setLogoState(logo);
      applyVar('--font-wordmark', logo, DEFAULT_LOGO_FONT);
      syncAttr('fontLogo', logo, DEFAULT_LOGO_FONT);
    }
    if (title && fontByKey(title)) {
      setTitleState(title);
      applyVar('--font-page-title', title, DEFAULT_TITLE_FONT);
      syncAttr('fontTitle', title, DEFAULT_TITLE_FONT);
    }
  }, []);

  const value = React.useMemo(
    () => ({
      logoFont,
      titleFont,
      uiFont,
      fontSize,
      setLogoFont,
      setTitleFont,
      setUiFont,
      setFontSize,
      adoptServerFonts,
    }),
    [
      logoFont,
      titleFont,
      uiFont,
      fontSize,
      setLogoFont,
      setTitleFont,
      setUiFont,
      setFontSize,
      adoptServerFonts,
    ],
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
export { DISPLAY_FONTS, UI_FONTS };
