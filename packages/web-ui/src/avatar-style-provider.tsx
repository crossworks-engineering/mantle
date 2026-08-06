'use client';

import * as React from 'react';
import { apiSend } from '@mantle/web-ui/api-fetch';
import { DEFAULT_AVATAR_STYLE, resolveAvatarStyle } from '@mantle/web-ui/avatar';

/**
 * The brain's avatar style — one visual language for every generated avatar.
 *
 * Same delivery contract as the colour theme (see color-theme-provider): the
 * value is SERVER-RENDERED into `<html data-avatar-style>` from the anchor
 * owner's preferences, so the document is already correct on arrival and this
 * provider only reads the attribute back as its initial state. No before-paint
 * script, no localStorage. The default style is the ABSENCE of the attribute.
 *
 * Why a provider rather than a prop: avatars render in the header, the sidebar,
 * chat bubbles and three settings screens, and the Appearance picker has to
 * repaint all of them live. Threading the style through every call site would
 * be the same value copied a dozen ways.
 */
type Ctx = {
  avatarStyle: string;
  /** Set, paint and persist. */
  setAvatarStyle: (id: string) => void;
};

const AvatarStyleContext = React.createContext<Ctx | null>(null);

function apply(id: string) {
  if (typeof document === 'undefined') return;
  if (id === DEFAULT_AVATAR_STYLE) {
    delete document.documentElement.dataset.avatarStyle;
  } else {
    document.documentElement.dataset.avatarStyle = id;
  }
}

export function AvatarStyleProvider({ children }: { children: React.ReactNode }) {
  const [avatarStyle, setState] = React.useState<string>(DEFAULT_AVATAR_STYLE);

  React.useEffect(() => {
    // resolveAvatarStyle, not the raw attribute: a brain that last saved a
    // boring-avatars id ('beam') must land on a style the picker can show.
    setState(resolveAvatarStyle(document.documentElement.dataset.avatarStyle));
  }, []);

  const setAvatarStyle = React.useCallback((id: string) => {
    const resolved = resolveAvatarStyle(id);
    setState(resolved);
    apply(resolved);
    // The DB copy is the source of truth; the next full page load renders it
    // into the HTML. Fire-and-forget — a failed write costs only the sync.
    void apiSend('/api/profile/avatar-style', 'PUT', { avatarStyle: resolved }).catch(() => {});
  }, []);

  return (
    <AvatarStyleContext.Provider value={{ avatarStyle, setAvatarStyle }}>
      {children}
    </AvatarStyleContext.Provider>
  );
}

/** The brain's avatar style. Falls back to the default outside a provider, so
 *  surfaces that don't mount one (share/print pages) still render avatars. */
export function useAvatarStyle(): Ctx {
  return (
    React.useContext(AvatarStyleContext) ?? {
      avatarStyle: DEFAULT_AVATAR_STYLE,
      setAvatarStyle: () => {},
    }
  );
}
