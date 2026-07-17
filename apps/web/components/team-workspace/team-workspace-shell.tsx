'use client';

/**
 * The /team member workspace shell — a read-only mirror of the owner app
 * shell's geometry: wordmark header (brain's site name, owner colour theme),
 * left section nav (Notes/Pages/Tables/Apps/Tasks/Events), footer with the
 * shared folders + Assistant. No Highlight, no owner chrome, no edit anywhere.
 *
 * Client-fetch on purpose (raw fetch, not apiFetch): /team is the external
 * member surface — auth is the team cookie, 401 renders the TokenGate, and
 * pages stay free of server DB reads (detached-safe, same as the old hub).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AppWindow,
  BookText,
  CalendarDays,
  CheckSquare,
  FileText,
  Folder,
  FolderTree,
  Menu,
  MessageCircle,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { navItemMatches } from '@/components/layout/nav-items';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/theme-toggle';
import { TokenGate } from '@/components/team-chat/token-gate';
import { cn } from '@/lib/utils';

export type WorkspaceData = {
  memberName: string | null;
  siteName: string | null;
  colorTheme: string | null;
  version: string;
  counts: Record<string, number>;
  folders: Array<{ token: string; title: string }>;
};

/** The left-nav sections, in display order — mirrors the owner sidebar's
 *  Workspace group (same icons), minus everything a member can't have.
 *  Shaped as NavItem (+ the share `type`) so active-route matching reuses the
 *  canonical navItemMatches helper instead of a drifting reimplementation. */
export const WORKSPACE_NAV: Array<{
  type: string;
  name: string;
  href: string;
  icon: LucideIcon;
}> = [
  { type: 'note', name: 'Notes', href: '/team/notes', icon: FileText },
  { type: 'page', name: 'Pages', href: '/team/pages', icon: BookText },
  { type: 'table', name: 'Tables', href: '/team/tables', icon: Table2 },
  { type: 'app', name: 'Apps', href: '/team/apps', icon: AppWindow },
  { type: 'task', name: 'Tasks', href: '/team/tasks', icon: CheckSquare },
  { type: 'event', name: 'Events', href: '/team/events', icon: CalendarDays },
  // Shared folders — the same section the footer's folder chips deep-link into
  // (count = shared folders, not files; every file under one is downloadable).
  { type: 'branch', name: 'Files', href: '/team/files', icon: FolderTree },
];

const WorkspaceContext = createContext<WorkspaceData | null>(null);

/** Shell data for section screens (greeting, counts). Null until loaded —
 *  children render inside the shell only after auth, so it's always set for
 *  them in practice. */
export function useWorkspace(): WorkspaceData | null {
  return useContext(WorkspaceContext);
}

function NavList({ data, onNavigate }: { data: WorkspaceData; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 p-2">
      {WORKSPACE_NAV.map((item) => {
        const active = navItemMatches(item, pathname);
        const count = data.counts[item.type] ?? 0;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{item.name}</span>
            {count > 0 && <span className="text-xs text-muted-foreground">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

export function TeamWorkspaceShell({ children }: { children: ReactNode }) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null); // null = resolving
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const pathname = usePathname();

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/team/workspace', { cache: 'no-store' });
      if (r.status === 401) {
        setAuthed(false);
        return;
      }
      if (!r.ok) return;
      setData((await r.json()) as WorkspaceData);
      setAuthed(true);
    } catch {
      // network blip — leave the current state; the member can retry
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Brand the member surface: stamp the OWNER's colour theme on <html> (same
  // lock OwnerColorTheme sets, so the visitor's localStorage never re-applies
  // over the brain's brand). Light/dark stays the member's own toggle.
  useEffect(() => {
    const t = data?.colorTheme;
    if (!t) return;
    document.documentElement.dataset.colorTheme = t;
    document.documentElement.dataset.colorThemeOwner = '1';
  }, [data?.colorTheme]);

  if (authed === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (!authed || !data) {
    return <TokenGate heading="Team Workspace" onAuthed={() => void refetch()} />;
  }

  const sectionLabel =
    pathname === '/team'
      ? null
      : pathname.startsWith('/team/assistant')
        ? 'Assistant'
        : (WORKSPACE_NAV.find((i) => navItemMatches(i, pathname))?.name ?? null);

  return (
    <WorkspaceContext.Provider value={data}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open sections">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-0 pt-10">
              <SheetTitle className="sr-only">Sections</SheetTitle>
              <NavList data={data} onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>
          <Link href="/team" className="font-logo text-2xl leading-none text-primary">
            {data.siteName || 'mantle'}
          </Link>
          <p className="min-w-0 flex-1 truncate text-center text-sm font-medium text-muted-foreground">
            {sectionLabel}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {data.memberName && (
              <span className="hidden text-xs text-muted-foreground sm:inline">{data.memberName}</span>
            )}
            <ThemeToggle />
          </div>
        </header>

        {/* ── Body: left nav + main ──────────────────────────────── */}
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-sidebar md:block">
            <NavList data={data} />
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
        </div>

        {/* ── Footer: shared folders + Assistant ─────────────────── */}
        <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-border bg-sidebar px-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {data.folders.map((f) => (
              <Link
                key={f.token}
                href={`/team/files?s=${encodeURIComponent(f.token)}`}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Folder className="size-3.5" aria-hidden />
                {f.title}
              </Link>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="h-8 shrink-0" asChild>
            <Link href="/team/assistant">
              <MessageCircle /> Assistant
            </Link>
          </Button>
        </footer>
      </div>
    </WorkspaceContext.Provider>
  );
}
