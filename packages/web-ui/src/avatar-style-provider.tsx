'use client';

import * as React from 'react';
import { apiSend } from '@mantle/web-ui/api-fetch';
import {
  DEFAULT_AVATAR_STYLE,
  DEFAULT_AVATAR_TINT,
  resolveAvatarStyle,
  resolveAvatarTint,
  type AvatarTint,
} from '@mantle/web-ui/avatar';

/**
 * The brain's avatar appearance — one style and one tint for every generated
 * avatar in the brain.
 *
 * Same delivery contract as the colour theme (see color-theme-provider): the
 * values are SERVER-RENDERED into `<html data-avatar-style|data-avatar-tint>`
 * from the anchor owner's preferences, so the document is already correct on
 * arrival and this provider only reads the attributes back as its initial
 * state. No before-paint script, no localStorage. A default is the ABSENCE of
 * the attribute.
 *
 * Why a provider rather than props: avatars render in the header, the sidebar,
 * chat bubbles and three settings screens, and the Appearance pickers have to
 * repaint all of them live. Threading two values through every call site would
 * be the same state copied a dozen ways.
 */
type Ctx = {
  avatarStyle: string;
  avatarTint: AvatarTint;
  /** Set, paint and persist. */
  setAvatarStyle: (id: string) => void;
  setAvatarTint: (tint: AvatarTint) => void;
};

const AvatarStyleContext = React.createContext<Ctx | null>(null);

/** Defaults are written as the ABSENCE of the attribute, matching how the
 *  server renders them — so the DOM never disagrees with a fresh page load. */
function applyAttr(name: 'avatarStyle' | 'avatarTint', value: string, fallback: string) {
  if (typeof document === 'undefined') return;
  if (value === fallback) delete document.documentElement.dataset[name];
  else document.documentElement.dataset[name] = value;
}

export function AvatarStyleProvider({ children }: { children: React.ReactNode }) {
  const [avatarStyle, setStyleState] = React.useState<string>(DEFAULT_AVATAR_STYLE);
  const [avatarTint, setTintState] = React.useState<AvatarTint>(DEFAULT_AVATAR_TINT);

  React.useEffect(() => {
    // Resolve rather than trust: a brain that last saved a boring-avatars id
    // ('beam') must land on a style the picker can actually show.
    setStyleState(resolveAvatarStyle(document.documentElement.dataset.avatarStyle));
    setTintState(resolveAvatarTint(document.documentElement.dataset.avatarTint));
  }, []);

  // The DB copy is the source of truth; the next full page load renders it into
  // the HTML. Fire-and-forget — a failed write costs only the sync.
  const persist = React.useCallback((body: Record<string, string>) => {
    void apiSend('/api/profile/avatar', 'PUT', body).catch(() => {});
  }, []);

  const setAvatarStyle = React.useCallback(
    (id: string) => {
      const resolved = resolveAvatarStyle(id);
      setStyleState(resolved);
      applyAttr('avatarStyle', resolved, DEFAULT_AVATAR_STYLE);
      persist({ avatarStyle: resolved });
    },
    [persist],
  );

  const setAvatarTint = React.useCallback(
    (tint: AvatarTint) => {
      const resolved = resolveAvatarTint(tint);
      setTintState(resolved);
      applyAttr('avatarTint', resolved, DEFAULT_AVATAR_TINT);
      persist({ avatarTint: resolved });
    },
    [persist],
  );

  return (
    <AvatarStyleContext.Provider value={{ avatarStyle, avatarTint, setAvatarStyle, setAvatarTint }}>
      {children}
    </AvatarStyleContext.Provider>
  );
}

/** The brain's avatar style + tint. Falls back to the defaults outside a
 *  provider, so surfaces that don't mount one (share/print) still draw. */
export function useAvatarStyle(): Ctx {
  return (
    React.useContext(AvatarStyleContext) ?? {
      avatarStyle: DEFAULT_AVATAR_STYLE,
      avatarTint: DEFAULT_AVATAR_TINT,
      setAvatarStyle: () => {},
      setAvatarTint: () => {},
    }
  );
}
