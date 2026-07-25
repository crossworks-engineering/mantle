'use client';

import * as React from 'react';
import { apiSend } from '@mantle/web-ui/api-fetch';
import {
  DISPLAY_FONTS,
  DEFAULT_LOGO_FONT,
  DEFAULT_TITLE_FONT,
  fontFamilyValue,
  fontByKey,
} from './display-fonts';

/**
 * Wordmark + page-title font selection. Two admin choices (Settings →
 * Appearance) override two CSS variables at runtime:
 *   --font-wordmark  → the header wordmark (default: the next/font Bukhari)
 *   --font-page-title → the centered header page title (default: the UI sans)
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

/** Mirror a chosen key into the <html> dataset (default clears the attribute,
 *  matching the server render, where "default" is the attribute's absence). */
function syncAttr(prop: 'fontLogo' | 'fontTitle', key: string, defaultKey: string) {
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

  // The document arrived with the brain's fonts already rendered (attributes +
  // inline vars, server-side). Read the attributes back as initial state — no
  // repaint needed, the DOM is already correct.
  React.useEffect(() => {
    const d = document.documentElement.dataset;
    setLogoState(readAttr(d.fontLogo, DEFAULT_LOGO_FONT));
    setTitleState(readAttr(d.fontTitle, DEFAULT_TITLE_FONT));
  }, []);

  const persist = React.useCallback((body: { fontLogo?: string; fontTitle?: string }) => {
    // The DB copy is the cross-browser source of truth; localStorage above is
    // the pre-paint cache. Fire-and-forget — a failed write costs only the sync.
    void apiSend('/api/profile/fonts', 'PUT', body).catch(() => {});
  }, []);

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
