'use client';

import * as React from 'react';
import { apiSend } from '@mantle/web-ui/api-fetch';
import {
  BACKGROUND_OFF,
  DEFAULT_AREA_BACKGROUNDS,
  decodeBackgrounds,
  encodeBackgrounds,
  isBackgroundChoice,
  type AreaBackgrounds,
  type BackgroundAreaId,
} from '@mantle/web-ui/backgrounds';

/**
 * Which generated background each area of the shell shows.
 *
 * Same delivery contract as the colour theme and the avatar style: the value is
 * SERVER-RENDERED into `<html data-backgrounds>` from the anchor owner's
 * preferences, so the document is already correct on arrival and this provider
 * only reads the attribute back as its initial state. No before-paint script,
 * no localStorage. A default is the ABSENCE of the pair.
 *
 * A provider rather than props because the four areas are in four different
 * corners of the shell (sidebar, header, chat, activity column) and the
 * Appearance picker has to repaint all of them live.
 */
type Ctx = {
  backgrounds: AreaBackgrounds;
  /** The area's choice: a style id, or `off`. */
  backgroundFor: (area: BackgroundAreaId) => string;
  /** Set, paint and persist one area. */
  setBackground: (area: BackgroundAreaId, choice: string) => void;
};

const BackgroundContext = React.createContext<Ctx | null>(null);

export function BackgroundProvider({ children }: { children: React.ReactNode }) {
  const [backgrounds, setBackgrounds] = React.useState<AreaBackgrounds>(() =>
    decodeBackgrounds(null),
  );

  React.useEffect(() => {
    setBackgrounds(decodeBackgrounds(document.documentElement.dataset.backgrounds));
  }, []);

  const setBackground = React.useCallback((area: BackgroundAreaId, choice: string) => {
    if (!isBackgroundChoice(choice)) return;
    setBackgrounds((prev) => {
      const next = { ...prev, [area]: choice };
      const encoded = encodeBackgrounds(next);
      // Mirror the encoding onto <html> so a full reload and this in-memory
      // state agree, and so "everything on its default" clears the attribute
      // rather than leaving a stale one behind.
      if (typeof document !== 'undefined') {
        if (encoded) document.documentElement.dataset.backgrounds = encoded;
        else delete document.documentElement.dataset.backgrounds;
      }
      // The DB copy is the source of truth; the next full load renders it into
      // the HTML. Fire-and-forget; a failed write costs only the sync.
      void apiSend('/api/profile/backgrounds', 'PUT', { backgrounds: encoded }).catch(() => {});
      return next;
    });
  }, []);

  const backgroundFor = React.useCallback(
    (area: BackgroundAreaId) => backgrounds[area] ?? DEFAULT_AREA_BACKGROUNDS[area],
    [backgrounds],
  );

  const value = React.useMemo(
    () => ({ backgrounds, backgroundFor, setBackground }),
    [backgrounds, backgroundFor, setBackground],
  );

  return <BackgroundContext.Provider value={value}>{children}</BackgroundContext.Provider>;
}

/** Falls back to the defaults outside a provider, so surfaces that don't mount
 *  one (share/print) still render sensibly. */
export function useBackgrounds(): Ctx {
  const ctx = React.useContext(BackgroundContext);
  const fallback = React.useMemo(() => decodeBackgrounds(null), []);
  return (
    ctx ?? {
      backgrounds: fallback,
      backgroundFor: (area: BackgroundAreaId) => fallback[area] ?? BACKGROUND_OFF,
      setBackground: () => {},
    }
  );
}

/** One area's choice. `off` means draw nothing. */
export function useAreaBackground(area: BackgroundAreaId): string {
  return useBackgrounds().backgroundFor(area);
}
