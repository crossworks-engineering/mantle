'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { Header } from '@/components/layout/header';
import { SidebarNav } from '@/components/layout/sidebar-nav';
import { UpdateBanner } from '@/components/layout/update-banner';
import { LiveColumn } from '@/components/layout/live-column';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ToastProvider } from '@/components/ui/toast';
import { PageTitleProvider } from '@/components/layout/page-title';
import { UploadProvider, UploadDock } from '@/components/uploads/upload-provider';
import { AssistantDockProvider, AssistantDock } from '@/components/assistant/assistant-dock';

/**
 * App shell — three fixed regions (header, left sidebar, right live
 * column) framing a scrollable content area. The sidebar collapses into
 * a Sheet drawer below md. The server-rendered context+cost card is
 * passed in as a prop.
 *
 * Collapse: the left nav and right Activity column each collapse to an
 * icon rail. Their widths are published as the `--nav-w` / `--activity-w`
 * CSS variables on the shell root, which every framing element (sidebar,
 * main, FleetLayout, mail shell, live column) offsets against — so one
 * state flip reflows the whole shell. Collapsed state is also mirrored as
 * `data-{nav,activity}-collapsed` for descendants to restyle via
 * `group-data-[…]/shell:` (the mobile drawer portals outside this root, so
 * it always renders expanded). State is persisted to cookies and seeded
 * from them server-side (see layout.tsx) for a flash-free first paint.
 */

const NAV_COOKIE = 'mantle_nav_collapsed';
const ACTIVITY_COOKIE = 'mantle_activity_collapsed';

function writeCookie(name: string, on: boolean) {
  document.cookie = `${name}=${on ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
}

export function AppShell({
  email,
  userAvatar,
  pendingApprovals,
  contextCard,
  initialNavCollapsed = false,
  initialActivityCollapsed = false,
  children,
}: {
  email: string | null;
  userAvatar?: { style: string; seed: string } | null;
  pendingApprovals: number;
  contextCard: React.ReactNode;
  initialNavCollapsed?: boolean;
  initialActivityCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(initialNavCollapsed);
  const [activityCollapsed, setActivityCollapsed] = useState(initialActivityCollapsed);
  const pathname = usePathname();

  // Close the drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggleNav = () =>
    setNavCollapsed((v) => {
      writeCookie(NAV_COOKIE, !v);
      return !v;
    });
  const toggleActivity = () =>
    setActivityCollapsed((v) => {
      writeCookie(ACTIVITY_COOKIE, !v);
      return !v;
    });

  // Keyboard shortcuts: ⌘/Ctrl+B toggles the nav, ⌘/Ctrl+J toggles Activity.
  // Skipped while typing / editing so ⌘B still bolds in the page editor and we
  // don't steal keystrokes from inputs. (setState setters are stable, so the
  // listener is registered once.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'b' && k !== 'j') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      if (k === 'b') {
        setNavCollapsed((v) => {
          writeCookie(NAV_COOKIE, !v);
          return !v;
        });
      } else {
        setActivityCollapsed((v) => {
          writeCookie(ACTIVITY_COOKIE, !v);
          return !v;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const body = (onNavigate?: () => void) => (
    <>
      {contextCard}
      <UpdateBanner onNavigate={onNavigate} />
      <SidebarNav
        pendingApprovals={pendingApprovals}
        onNavigate={onNavigate}
      />
    </>
  );

  return (
    <ToastProvider>
      <PageTitleProvider>
      <UploadProvider>
      <AssistantDockProvider>
      <div
        className="group/shell h-screen bg-background"
        data-nav-collapsed={navCollapsed ? 'true' : 'false'}
        data-activity-collapsed={activityCollapsed ? 'true' : 'false'}
        style={
          {
            '--nav-w': navCollapsed ? '3.5rem' : '16rem',
            '--activity-w': activityCollapsed ? '3.5rem' : '20rem',
          } as React.CSSProperties
        }
      >
        <Header email={email} userAvatar={userAvatar} onMenuClick={() => setMobileOpen(true)} />

        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--nav-w)] flex-col border-r bg-sidebar pt-16 transition-[width] duration-200 ease-in-out md:flex">
          <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">{body()}</div>
          {/* Collapse toggle, pinned at the foot of the rail. */}
          <div className="shrink-0 border-t border-border p-2">
            <button
              type="button"
              onClick={toggleNav}
              aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              title={navCollapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[nav-collapsed=true]/shell:justify-center group-data-[nav-collapsed=true]/shell:px-0"
            >
              <PanelLeftClose className="size-4 shrink-0 group-data-[nav-collapsed=true]/shell:hidden" aria-hidden />
              <PanelLeft className="hidden size-4 shrink-0 group-data-[nav-collapsed=true]/shell:block" aria-hidden />
              <span className="group-data-[nav-collapsed=true]/shell:hidden">Collapse</span>
              <kbd className="ml-auto rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground group-data-[nav-collapsed=true]/shell:hidden">
                ⌘B
              </kbd>
            </button>
          </div>
        </aside>

        {/* Mobile sidebar drawer — portaled outside the shell root, so it
            always renders expanded regardless of collapse state. */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-80 overflow-y-auto p-0 pt-4 scrollbar-thin">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {body(() => setMobileOpen(false))}
          </SheetContent>
        </Sheet>

        {/* Right live-activity column */}
        <LiveColumn collapsed={activityCollapsed} onToggle={toggleActivity} />

        {/* Content area */}
        <main className="fixed inset-0 top-16 overflow-y-auto scrollbar-thin transition-[left,right] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[var(--activity-w)]">
          {children}
        </main>

        {/* App-wide docks: a bottom-right stack so uploads + chat never
            overlap. Inside the shell so it inherits --activity-w (sits left of
            the activity rail) and persists across route changes.
            pointer-events-none lets clicks fall through the gaps; each dock
            re-enables its own. */}
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-96 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-3 lg:right-[calc(var(--activity-w)+1rem)]">
          <UploadDock />
          <AssistantDock />
        </div>
      </div>
      </AssistantDockProvider>
      </UploadProvider>
      </PageTitleProvider>
    </ToastProvider>
  );
}
