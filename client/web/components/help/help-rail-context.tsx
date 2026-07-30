'use client';

import * as React from 'react';

/**
 * Open/closed state for the help rail, shared between the footer launcher and
 * the shell that renders the column and publishes its width.
 *
 * Deliberately tiny and separate from the assistant's dock context: the two
 * columns are siblings, not modes of one thing, and keeping the state apart is
 * what lets the shell decide how they stack when both are open.
 */
type Ctx = {
  open: boolean;
  /** True once opened at least once — gates mounting the lazy panel at all. */
  everOpened: boolean;
  toggle: () => void;
  close: () => void;
};

const HelpRailContext = React.createContext<Ctx | null>(null);

export function HelpRailProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [everOpened, setEverOpened] = React.useState(false);

  const toggle = React.useCallback(() => {
    setOpen((prev) => {
      if (!prev) setEverOpened(true);
      return !prev;
    });
  }, []);
  const close = React.useCallback(() => setOpen(false), []);

  const value = React.useMemo(
    () => ({ open, everOpened, toggle, close }),
    [open, everOpened, toggle, close],
  );
  return <HelpRailContext.Provider value={value}>{children}</HelpRailContext.Provider>;
}

/** Safe outside the provider (returns a closed, inert state) so a stray
 *  launcher can never crash a screen that renders without the shell. */
export function useHelpRail(): Ctx {
  return (
    React.useContext(HelpRailContext) ?? {
      open: false,
      everOpened: false,
      toggle: () => {},
      close: () => {},
    }
  );
}
