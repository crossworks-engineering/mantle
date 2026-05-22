'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Menu, User as UserIcon } from 'lucide-react';
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
import { usePageTitle } from '@/components/layout/page-title';

export function Header({
  email,
  userAvatar,
  onMenuClick,
}: {
  email: string | null;
  userAvatar?: { style: string; seed: string } | null;
  onMenuClick: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const initials = (email ?? 'M').slice(0, 2).toUpperCase();
  const pageTitle = usePageTitle();

  async function signOut() {
    setBusy(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </Button>

      <Link href="/" className="flex items-center" aria-label="Mantle home">
        <span className="font-logo text-3xl leading-none text-primary">mantle</span>
      </Link>

      {pageTitle && (
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 hidden max-w-[40vw] -translate-x-1/2 -translate-y-1/2 truncate text-center font-logo text-3xl lowercase leading-none text-primary/70 md:block"
          aria-hidden
        >
          {pageTitle}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
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
