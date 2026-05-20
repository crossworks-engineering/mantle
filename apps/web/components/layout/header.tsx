'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Menu, TreePine, User as UserIcon } from 'lucide-react';
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
import { ThemeToggle } from '@/components/theme-toggle';

/** Route → page title for the header. Longest-prefix wins. */
const TITLES: Array<[string, string]> = [
  ['/assistant', 'Assistant'],
  ['/files', 'Files'],
  ['/notes', 'Notes'],
  ['/todos', 'Todos'],
  ['/events', 'Events'],
  ['/secrets', 'Secrets'],
  ['/pending', 'Pending'],
  ['/traces', 'Traces'],
  ['/debug', 'Debug'],
  ['/settings/senders', 'Senders'],
  ['/settings/accounts', 'Accounts'],
  ['/settings/profile', 'Profile'],
  ['/settings/keys', 'API keys'],
  ['/settings/agents', 'Agents'],
  ['/settings/ai-workers', 'AI workers'],
  ['/settings/tools', 'Tools'],
  ['/settings/skills', 'Skills'],
  ['/settings/heartbeats', 'Heartbeats'],
  ['/settings/security', 'Security'],
  ['/settings', 'Settings'],
];

function titleFor(pathname: string): string {
  if (pathname === '/') return 'Inbox';
  for (const [prefix, label] of TITLES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/') || pathname === prefix) return label;
  }
  return 'Mantle';
}

export function Header({
  email,
  onMenuClick,
}: {
  email: string | null;
  onMenuClick: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const title = titleFor(pathname);
  const initials = (email ?? 'M').slice(0, 2).toUpperCase();

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

      <Link href="/" className="flex items-center gap-2">
        <TreePine className="size-5 text-primary" aria-hidden />
        <span className="text-sm font-semibold">Mantle</span>
      </Link>

      <div className="ml-2 hidden h-5 w-px bg-border md:block" />
      <h1 className="hidden text-sm font-medium text-muted-foreground md:block">{title}</h1>

      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-10 gap-2 px-2">
              <Avatar className="size-8">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
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
                <UserIcon className="mr-2 size-4" /> Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={signOut}
              disabled={busy}
              className="cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOut className="mr-2 size-4" /> {busy ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
