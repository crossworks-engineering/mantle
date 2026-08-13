'use client';

import * as React from 'react';
import { apiSend } from '@mantle/web-ui/api-fetch';
import {
  DEFAULT_LOGO_FONT,
  DEFAULT_TITLE_FONT,
  DEFAULT_UI_FONT,
  DEFAULT_PROSE_FONT,
  DEFAULT_FONT_SIZE,
  fontFamilyValue,
  fontByKey,
  resolveFontSize,
  type FontSize,
} from './display-fonts';

/**
 * Typography selection — four faces and four sizes. Admin choices (Settings →
 * Appearance) override CSS variables and `<html>` attributes at runtime:
 *
 *   --font-sans       → the whole interface (default: the next/font Inter)
 *   --font-wordmark   → the header wordmark (default: Bricolage Grotesque)
 *   --font-page-title → the header-centre peer name (default: follow the UI)
 *   --font-prose      → Pages, Notes and the PDF export (default: follow the UI)
 *
 *   data-font-size    → the ROOT font-size, so the rem-based shell scales
 *   data-logo-size / data-title-size / data-prose-size
 *                     → local multipliers, resolved to numbers by app.css
 *
 * Elements read the vars with a var() fallback, so "default" is simply *not
 * setting* the variable, and app.css keys the size rules off the absence of an
 * attribute. Live: setting a choice repaints instantly.
 *
 * Persistence mirrors the colour theme exactly: the DB copy
 * (profiles.preferences on the anchor owner) is the source of truth, rendered
 * server-side into the `<html>` attributes + inline style vars (see
 * @mantle/web-ui/appearance) — the document arrives painted; this provider
 * reads the attributes back on mount and writes changes through
 * fire-and-forget.
 */

/** The four selectable slots. One record per slot keeps every setter, every
 *  attribute and every persisted field derivable from a single table instead of
 *  four near-identical copies that drift. */
const SLOTS = {
  ui: {
    var: '--font-sans',
    attr: 'fontUi',
    field: 'fontUi',
    default: DEFAULT_UI_FONT,
    sizeAttr: 'fontSize',
    sizeField: 'fontSize',
  },
  logo: {
    var: '--font-wordmark',
    attr: 'fontLogo',
    field: 'fontLogo',
    default: DEFAULT_LOGO_FONT,
    sizeAttr: 'logoSize',
    sizeField: 'fontLogoSize',
  },
  title: {
    var: '--font-page-title',
    attr: 'fontTitle',
    field: 'fontTitle',
    default: DEFAULT_TITLE_FONT,
    sizeAttr: 'titleSize',
    sizeField: 'fontTitleSize',
  },
  prose: {
    var: '--font-prose',
    attr: 'fontProse',
    field: 'fontProse',
    default: DEFAULT_PROSE_FONT,
    sizeAttr: 'proseSize',
    sizeField: 'fontProseSize',
  },
} as const;

export type FontSlot = keyof typeof SLOTS;

type Ctx = {
  /** The chosen key per slot; always a key the registry knows. */
  fonts: Record<FontSlot, string>;
  /** The chosen size per slot. */
  sizes: Record<FontSlot, FontSize>;
  setFont: (slot: FontSlot, key: string) => void;
  setSize: (slot: FontSlot, size: FontSize) => void;
  /** Apply server-stored choices (shell load) without writing back — the DB
   *  copy is already the source they came from. A choice is a face AND a size
   *  (the .wordmark class applies them as one), so both reconcile together —
   *  adopting only the face would repaint browser B in the new family at the
   *  old scale, exactly the half-applied state the class design prevents. */
  adoptServerFonts: (
    fonts: Partial<Record<FontSlot, string | null>>,
    sizes?: Partial<Record<FontSlot, string | null>>,
  ) => void;
};

const FontContext = React.createContext<Ctx | null>(null);

/** Set/clear a var on <html>. The default choice CLEARS (the element falls to
 *  its var() fallback, which app.css defines); anything else sets the resolved
 *  font-family. Unknown keys clear too, so a key removed from the registry
 *  never strands an element on a face that no longer ships. */
function applyVar(prop: string, key: string, defaultKey: string) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const value = key === defaultKey ? null : fontFamilyValue(key);
  if (value) root.style.setProperty(prop, value);
  else root.style.removeProperty(prop);
}

/** Mirror a chosen value into the <html> dataset (default clears the attribute,
 *  matching the server render, where "default" is the attribute's absence). */
function syncAttr(prop: string, value: string, defaultValue: string) {
  if (typeof document === 'undefined') return;
  const d = document.documentElement.dataset;
  if (value === defaultValue) delete d[prop];
  else d[prop] = value;
}

/** Read a server-rendered key attribute off <html>, falling back to the default
 *  when absent or unknown (a key removed from the registry must not become
 *  picker state). 'inherit' on the ui slot is rejected the same way — the
 *  server never emits it, but a stale or hand-edited document must not seed
 *  state the dialog cannot display. */
function readKey(slot: FontSlot, value: string | undefined, fallback: string): string {
  const known = fontByKey(value);
  if (!known) return fallback;
  if (slot === 'ui' && known.key === 'inherit') return fallback;
  return known.key;
}

const SLOT_KEYS = Object.keys(SLOTS) as FontSlot[];

function defaults<T>(fn: (slot: FontSlot) => T): Record<FontSlot, T> {
  return Object.fromEntries(SLOT_KEYS.map((s) => [s, fn(s)])) as Record<FontSlot, T>;
}

export function FontProvider({ children }: { children: React.ReactNode }) {
  const [fonts, setFonts] = React.useState<Record<FontSlot, string>>(() =>
    defaults((s) => SLOTS[s].default),
  );
  const [sizes, setSizes] = React.useState<Record<FontSlot, FontSize>>(() =>
    defaults(() => DEFAULT_FONT_SIZE),
  );

  // The document arrived with the brain's fonts already rendered (attributes +
  // inline vars, server-side). Read the attributes back as initial state — no
  // repaint needed, the DOM is already correct.
  React.useEffect(() => {
    const d = document.documentElement.dataset;
    setFonts(defaults((s) => readKey(s, d[SLOTS[s].attr], SLOTS[s].default)));
    setSizes(defaults((s) => resolveFontSize(d[SLOTS[s].sizeAttr])));
  }, []);

  const persist = React.useCallback((body: Record<string, string>) => {
    // The DB copy is the cross-browser source of truth. Fire-and-forget — a
    // failed write costs only the sync, never the repaint the user just saw.
    void apiSend('/api/profile/fonts', 'PUT', body).catch(() => {});
  }, []);

  // Each setter touches ONLY its own slot and persists ONLY its own field — no
  // dependence on another slot's state. (A combined apply() reading the others
  // from a closure could revert one when two change before a re-render.) The
  // dataset key is kept in sync with the style var so the DOM stays
  // self-consistent with what the server would have rendered.
  const setFont = React.useCallback(
    (slot: FontSlot, key: string) => {
      const face = fontByKey(key);
      if (!face) return;
      // 'inherit' means "follow the interface font" — a relationship the
      // interface slot cannot have with itself. Applied there it would set
      // --font-sans to var(--font-sans, …), a self-referential custom property
      // that invalidates the var and drops the whole app to the UA default
      // font. The dialog never offers it for this slot; this guards the data
      // path (see resolveFontVars for the server-render twin of this check).
      if (slot === 'ui' && face.key === 'inherit') return;
      const spec = SLOTS[slot];
      setFonts((prev) => ({ ...prev, [slot]: face.key }));
      applyVar(spec.var, face.key, spec.default);
      syncAttr(spec.attr, face.key, spec.default);
      persist({ [spec.field]: face.key });
    },
    [persist],
  );

  const setSize = React.useCallback(
    (slot: FontSlot, size: FontSize) => {
      const spec = SLOTS[slot];
      const resolved = resolveFontSize(size);
      setSizes((prev) => ({ ...prev, [slot]: resolved }));
      // No var: app.css keys every size off the attribute, so the cascade does
      // the scaling and there is nothing to recompute here.
      syncAttr(spec.sizeAttr, resolved, DEFAULT_FONT_SIZE);
      persist({ [spec.sizeField]: resolved });
    },
    [persist],
  );

  // Live sync from /api/shell (another browser changed the brain's fonts
  // mid-session) — adopt ONLY slots the server actually has. A null means
  // "never saved": the server-rendered document already reflects that (no
  // attribute), so there is nothing to undo.
  const adoptServerFonts = React.useCallback(
    (
      incoming: Partial<Record<FontSlot, string | null>>,
      incomingSizes?: Partial<Record<FontSlot, string | null>>,
    ) => {
      for (const slot of SLOT_KEYS) {
        const key = incoming[slot];
        const face = key ? fontByKey(key) : undefined;
        if (face && !(slot === 'ui' && face.key === 'inherit')) {
          // Same self-reference guard as setFont: 'inherit' is not a value the
          // interface slot can hold.
          const spec = SLOTS[slot];
          setFonts((prev) => ({ ...prev, [slot]: face.key }));
          applyVar(spec.var, face.key, spec.default);
          syncAttr(spec.attr, face.key, spec.default);
        }
        // Sizes ride the same null contract: null/absent means "never saved",
        // and the server-rendered document already reflects that.
        const size = incomingSizes?.[slot];
        if (size) {
          const resolved = resolveFontSize(size);
          setSizes((prev) => ({ ...prev, [slot]: resolved }));
          syncAttr(SLOTS[slot].sizeAttr, resolved, DEFAULT_FONT_SIZE);
        }
      }
    },
    [],
  );

  const value = React.useMemo(
    () => ({ fonts, sizes, setFont, setSize, adoptServerFonts }),
    [fonts, sizes, setFont, setSize, adoptServerFonts],
  );

  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}

export function useFonts() {
  const ctx = React.useContext(FontContext);
  if (!ctx) throw new Error('useFonts must be used within FontProvider');
  return ctx;
}
