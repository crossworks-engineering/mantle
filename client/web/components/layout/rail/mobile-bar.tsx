'use client';

import Link from 'next/link';
import { Menu, Search } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { Button } from '@mantle/web-ui/ui/button';
import { AreaBackdrop } from '@mantle/web-ui/area-backdrop';
import { BrandLogo } from './brand-logo';
import { ProfileMenu, type ProfileIdentity } from './profile-menu';

/**
 * The only chrome left across the top of the window, and only below `md`.
 *
 * Everything in this shell now lives in the left rail — which below `md` is a
 * drawer that starts closed. Something has to open it, name the brain, and get
 * to search and the account without a round trip through the drawer, so phones
 * keep a 3rem bar. Wide screens, where the rail is always visible and the whole
 * point of the change was to stop spending height on chrome, get nothing.
 *
 * Its height is `--top-bar-h` (globals.css), which is 0 at `md` and up and in
 * focus mode; every framed region in the shell offsets its top against that
 * variable, so this component's existence is declared in exactly one place.
 *
 * The `header` area backdrop is drawn here AND behind the rail's brand block:
 * between them they are the whole of what the old fixed header was, and the
 * Appearance setting should keep meaning the same thing at every width.
 */
export function MobileBar({
  identity,
  siteName,
  logoVersion,
  logoDarkVersion,
  onMenuClick,
  onSearchClick,
}: {
  identity: ProfileIdentity;
  siteName?: string | null;
  logoVersion?: string | null;
  logoDarkVersion?: string | null;
  onMenuClick: () => void;
  onSearchClick: () => void;
}) {
  const name = siteName || 'mantle';

  return (
    <header className="fixed inset-x-0 top-0 z-40 flex h-[var(--top-bar-h)] items-center gap-1 border-b border-sidebar-border bg-sidebar px-2 md:hidden">
      {/* `-z-10` rather than making every child `relative`: the bar is
          `fixed z-40` and owns a stacking context, so a negative-z child paints
          above its background and below all of them. */}
      <AreaBackdrop area="header" className="-z-10" />

      {/* Bare icons — the Button base supplies size-4; a local size would make
          these two a step larger than every other icon-in-Button in the shell. */}
      <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open menu">
        <Menu />
      </Button>

      <Link
        href="/"
        aria-label={`${name} home`}
        className="flex min-w-0 flex-1 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <BrandLogo
          name={name}
          logoVersion={logoVersion}
          logoDarkVersion={logoDarkVersion}
          imgClassName="h-7 w-auto max-w-[40vw] object-contain object-left"
          renderWordmark={(visibility) => (
            /* Width-only clipping, as in the rail: the wordmark faces overshoot
               the em box and `truncate` would shave the letterforms. */
            <span
              className={cn(
                'wordmark -mx-1 max-w-[40vw] overflow-x-clip overflow-y-visible whitespace-nowrap px-1 leading-none text-primary-ink',
                visibility,
              )}
            >
              {name}
            </span>
          )}
        />
      </Link>

      <Button variant="ghost" size="icon" onClick={onSearchClick} aria-label="Search">
        <Search />
      </Button>
      <ProfileMenu identity={identity} variant="bar" />
    </header>
  );
}
