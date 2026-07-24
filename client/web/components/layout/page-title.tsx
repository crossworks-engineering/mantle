'use client';

import * as React from 'react';

/**
 * Page-title channel. Each page declares its title via <SetPageTitle>;
 * the global Header (see components/layout/header.tsx) reads it and
 * renders it centered in the top bar, in the logo font at 50% primary.
 * This replaces the per-page in-content <h1> headers so every page has
 * the same calm, full-bleed content area (like /inbox).
 */
type Ctx = { title: string; setTitle: (t: string) => void };

const PageTitleContext = React.createContext<Ctx | null>(null);

export function PageTitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = React.useState('');
  const value = React.useMemo(() => ({ title, setTitle }), [title]);
  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>;
}

/** Read the current page title (used by the Header). */
export function usePageTitle(): string {
  return React.useContext(PageTitleContext)?.title ?? '';
}

/**
 * Declare the current page's title. Renders nothing; sets the title on
 * mount/update and clears it on unmount. Safe to drop into a server
 * component's JSX (it's a client component).
 */
export function SetPageTitle({ title }: { title: string }) {
  const setTitle = React.useContext(PageTitleContext)?.setTitle;
  React.useEffect(() => {
    setTitle?.(title);
    return () => setTitle?.('');
  }, [title, setTitle]);
  return null;
}
