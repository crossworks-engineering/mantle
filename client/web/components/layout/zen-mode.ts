'use client';

import { createContext, useContext } from 'react';

/**
 * Distraction-free ("focus") mode: the app shell hides its four chrome
 * regions (header, nav column, activity column, footer) and the content
 * area takes the whole viewport, with a floating exit button top-right.
 *
 * The shell owns the state and provides this context; screens that earn the
 * mode render a `<FocusToggle />` in their own toolbar — the Pages and Draw
 * editors, for writing, and their list previews, for reading and sharing
 * without opening the editor at all. A list screen also drops its own list
 * column (see `focus-layout.ts`), or the chrome would go and the biggest
 * distraction would stay.
 * The default value is a no-op so a component using the hook outside the
 * shell (shares, tests) degrades to "no focus mode" instead of crashing.
 * Deliberately ephemeral — no cookie: entering focus is a per-session act,
 * and coming back to a chrome-less app would read as broken.
 */
export const ZenModeContext = createContext<{ zen: boolean; toggle: () => void }>({
  zen: false,
  toggle: () => {},
});

export function useZenMode() {
  return useContext(ZenModeContext);
}
