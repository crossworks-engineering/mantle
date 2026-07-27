'use client';

/**
 * The /team member workspace shell — a read-only mirror of the owner app
 * shell's geometry: wordmark header (brain's site name, owner colour theme),
 * left section nav (Notes/Pages/Tables/Apps/Tasks/Events), footer with the
 * shared folders + Assistant. No Highlight, no owner chrome, no edit anywhere.
 *
 * Client-fetch on purpose (teamFetch, not apiFetch): /team is the external
 * member surface — auth is the team credential (cookie same-origin, bearer on
 * the split client origin), 401 renders the TokenGate, and pages stay free of
 * server DB reads (detached-safe, same as the old hub).
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
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
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { navItemMatches } from '@mantle/web-ui/layout/nav-items';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@mantle/web-ui/ui/sheet';
import { ThemeToggle } from '@mantle/web-ui/theme-toggle';
import { TokenGate } from '@/components/team-chat/token-gate';
import { teamFetch, upgradeTeamCookie } from '@mantle/web-ui/team-fetch';
import { serverUrl } from '@mantle/web-ui/runtime-env';
import { cn } from '@mantle/web-ui/lib/utils';

export type WorkspaceData = {
  memberName: string | null;
  siteName: string | null;
  /** The brain's federation label — centred in the header like the owner shell. */
  peerName: string | null;
  /** Brand logo version; set ⇒ an image replaces the wordmark text. */
  logoVersion: string | null;
  logoDarkVersion?: string | null;
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
  exact?: boolean;
}> = [
  // Dashboard = the /team overview itself — exact so it doesn't stay lit on
  // every subroute (same trick the owner sidebar uses for "/").
  { type: 'dashboard', name: 'Dashboard', href: '/team', icon: LayoutDashboard, exact: true },
  // The Forum leads the sections: it's the team's shared threads with the
  // brain — the successor to the 1:1 Assistant chat (now the read-only Archive).
  { type: 'forum', name: 'Forum', href: '/team/forum', icon: MessagesSquare },
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
      const r = await teamFetch('/api/team/workspace', { cache: 'no-store' });
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
    // Same-origin sessions minted in bearer mode regain the cookie the /s
    // subresources (inline-reader images, downloads, rows) authenticate by.
    void upgradeTeamCookie();
    void refetch();
  }, [refetch]);

  // No theme stamping here: the OWNER's brand + the `data-color-theme-owner`
  // lock arrive server-rendered on <html> (root layout + middleware member
  // flag) — see team-hub-client for the full rationale. Light/dark stays the
  // member's own toggle.

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
        ? 'Chat archive'
        : (WORKSPACE_NAV.find((i) => navItemMatches(i, pathname))?.name ?? null);

  return (
    <WorkspaceContext.Provider value={data}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ── Header — the owner shell's brand treatment, member-sized:
               wordmark in the user-selectable wordmark font, the brain's peer
               name centred (page-title font, chart-2), the primary-tinted
               gradient. Below md the centre shows the section label instead
               (the sidebar that names the section is hidden there). ─────── */}
        <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-border bg-gradient-to-b from-primary/10 to-background px-4">
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
          <Link
            href="/team"
            className="flex min-w-0 items-baseline"
            aria-label={`${data.siteName || 'Mantle'} team home`}
          >
            {data.logoVersion || data.logoDarkVersion ? (
              /* Uploaded brand logo — fixed height, width free, never
                 distorted; bounded by the h-14 header like the peer name.
                 Light/dark are two imgs swapped by the `dark:` classes, same
                 as the owner header: dark shows the dark variant when set,
                 else the base; light shows the base, else the wordmark. */
              <>
                {data.logoVersion ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={serverUrl(`/api/appearance/logo?v=${data.logoVersion}`)}
                    alt={data.siteName || 'Mantle'}
                    className={
                      'h-9 w-auto max-w-[45vw] object-contain' +
                      (data.logoDarkVersion ? ' dark:hidden' : '')
                    }
                  />
                ) : (
                  <span
                    className="-mx-2 max-w-[45vw] overflow-x-clip overflow-y-visible whitespace-nowrap px-2 py-1 text-2xl text-primary-ink dark:hidden"
                    style={{ fontFamily: 'var(--font-wordmark, var(--font-logo))' }}
                  >
                    {data.siteName || 'mantle'}
                  </span>
                )}
                {data.logoDarkVersion && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={serverUrl(`/api/appearance/logo?variant=dark&v=${data.logoDarkVersion}`)}
                    alt={data.siteName || 'Mantle'}
                    className="hidden h-9 w-auto max-w-[45vw] object-contain dark:block"
                  />
                )}
              </>
            ) : (
              /* Script/display faces overshoot the em box — clip only the WIDTH
                 and let the height overflow, same as the owner header. */
              <span
                className="-mx-2 max-w-[45vw] overflow-x-clip overflow-y-visible whitespace-nowrap px-2 py-1 text-2xl text-primary-ink"
                style={{ fontFamily: 'var(--font-wordmark, var(--font-logo))' }}
              >
                {data.siteName || 'mantle'}
              </span>
            )}
          </Link>
          {data.peerName && (
            <span
              className="pointer-events-none absolute left-1/2 top-1/2 hidden max-w-[40vw] -translate-x-1/2 -translate-y-1/2 overflow-x-clip overflow-y-visible whitespace-nowrap px-2 py-[2px] text-center text-lg font-bold leading-normal text-chart-2 md:block"
              style={{ fontFamily: 'var(--font-page-title)' }}
            >
              {data.peerName}
            </span>
          )}
          <p className="min-w-0 flex-1 truncate text-center text-sm font-medium text-muted-foreground md:hidden">
            {sectionLabel}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {data.memberName && (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {data.memberName}
              </span>
            )}
            <ThemeToggle />
          </div>
        </header>

        {/* ── Body: left nav + main ──────────────────────────────── */}
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-sidebar scrollbar-thin md:block">
            <NavList data={data} />
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
        </div>

        {/* ── Footer: shared folders + Assistant ─────────────────── */}
        <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-border bg-sidebar px-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin">
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
            <Link href="/team/forum">
              <MessagesSquare /> Forum
            </Link>
          </Button>
        </footer>
      </div>
    </WorkspaceContext.Provider>
  );
}
