'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Menu, Search, User as UserIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { BoringAvatar } from '@/components/boring-avatar';
import { ThemeToggle } from '@/components/theme-toggle';
import { RandomThemeToggle } from '@/components/random-theme-toggle';

export function Header({
  email,
  userAvatar,
  siteName,
  peerName,
  onMenuClick,
  onSearchClick,
}: {
  email: string | null;
  userAvatar?: { style: string; seed: string } | null;
  /** Custom wordmark from prefs; null/undefined ⇒ the "mantle" default. */
  siteName?: string | null;
  /** This brain's peer name, shown centred; null/undefined ⇒ empty centre. */
  peerName?: string | null;
  onMenuClick: () => void;
  /** Opens the global search palette (the ⌘K twin for mouse/touch). */
  onSearchClick: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const initials = (email ?? 'M').slice(0, 2).toUpperCase();

  async function signOut() {
    setBusy(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 border-b bg-background bg-gradient-to-b from-primary/10 to-background px-4 md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </Button>

      <Link
        href="/"
        className="flex min-w-0 items-baseline"
        aria-label={`${siteName || 'Mantle'} home`}
      >
        {/* Bukhari's swashes overshoot the em box; the truncate overflow box needs
            padding (clip happens at the padding edge) or the ink gets shaved. The
            negative x-margin cancels the layout shift so the wordmark stays aligned.
            Font: the user-selectable wordmark var (Settings → Appearance → Fonts),
            defaulting to the next/font Bukhari when unset. */}
        <span
          className="-mx-2 max-w-[45vw] truncate px-2 py-1 text-2xl text-primary"
          style={{ fontFamily: 'var(--font-wordmark, var(--font-logo))' }}
        >
          {siteName || 'mantle'}
        </span>
      </Link>

      {peerName && (
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 hidden max-w-[40vw] -translate-x-1/2 -translate-y-1/2 truncate px-2 py-[2px] text-center text-lg font-bold leading-normal text-chart-2 md:block"
          // Peer name in the user-selectable header-centre font (Settings →
          // Appearance → Fonts; unset ⇒ inherits the UI sans). py-[2px] + normal
          // leading give tall display glyphs room so `truncate`'s clip box
          // (overflow-hidden) doesn't shave their ascenders/descenders.
          style={{ fontFamily: 'var(--font-page-title)' }}
        >
          {peerName}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" onClick={onSearchClick} aria-label="Search">
          <Search className="size-5" />
        </Button>
        <RandomThemeToggle />
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-10 gap-2 px-2">
              {userAvatar ? (
                <BoringAvatar variant={userAvatar.style} seed={userAvatar.seed} size={32} />
              ) : (
                <Avatar className="size-8">
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
              )}
              {email && (
                <span className="hidden max-w-[12rem] truncate text-sm md:inline">{email}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
              {email ?? 'Signed in'}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/profile" className="cursor-pointer">
                <UserIcon className="size-4" /> Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={signOut}
              disabled={busy}
              className="cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOut className="size-4" /> {busy ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
