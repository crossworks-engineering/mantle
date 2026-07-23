'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { useColorTheme } from '@/components/color-theme-provider';
import { useFonts } from '@/components/font-provider';
import { COLOR_THEMES } from '@/lib/themes';
import { setAssetToken } from '@/lib/asset-url';
import { Header } from '@/components/layout/header';
import { SidebarNav } from '@/components/layout/sidebar-nav';
import { ChangelogLink } from '@/components/layout/changelog-link';
import { UpdateBanner } from '@/components/layout/update-banner';
import { LiveColumn } from '@/components/layout/live-column';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ToastProvider } from '@/components/ui/toast';
import { PageTitleProvider } from '@/components/layout/page-title';
import { UploadProvider, UploadDock } from '@/components/uploads/upload-provider';
import { AssistantDockProvider, useAssistantDock } from '@/components/assistant/assistant-dock';
import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { PendingQuestionWatcher } from '@/components/pending/question-watcher';
import { PickMode } from '@/components/assistant/pick-mode';
import { FooterBar } from '@/components/layout/footer-bar';
import { recordNavVisit } from '@/lib/nav-usage';
import { matchNavItem } from '@/components/layout/nav-items';
import { SearchPalette } from '@/components/search/search-palette';

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

type ShellData = {
  onboarded: boolean;
  avatar: { style: string; seed: string } | null;
  pendingApprovals: number;
  /** Custom header wordmark (Settings → Profile → Site name); null ⇒ "mantle". */
  siteName: string | null;
  /** The DB-stored colour theme (the cross-browser source of truth); null ⇒
   *  never saved. Adopted once per shell load. */
  colorTheme: string | null;
  /** DB-stored wordmark + page-title font keys (Settings → Appearance → Fonts);
   *  null ⇒ the defaults. Adopted once per shell load, like the colour theme. */
  fontLogo: string | null;
  fontTitle: string | null;
  /** Short-lived asset-access token for browser-native srcs in detached mode
   *  (see lib/asset-url). Absent/ignored same-origin. */
  assetToken?: string;
};

export function AppShell(props: {
  email: string | null;
  contextCard: React.ReactNode;
  initialNavCollapsed?: boolean;
  initialActivityCollapsed?: boolean;
  children: React.ReactNode;
}) {
  // Providers only — the frame itself lives in <ShellFrame/>, which sits INSIDE
  // AssistantDockProvider so it can read the dock state (the docked assistant
  // column publishes its width to the frame's CSS vars).
  return (
    <ToastProvider>
      <PageTitleProvider>
        <UploadProvider>
          <AssistantDockProvider>
            <ShellFrame {...props} />
          </AssistantDockProvider>
        </UploadProvider>
      </PageTitleProvider>
    </ToastProvider>
  );
}

function ShellFrame({
  email,
  contextCard,
  initialNavCollapsed = false,
  initialActivityCollapsed = true,
  children,
}: {
  email: string | null;
  contextCard: React.ReactNode;
  initialNavCollapsed?: boolean;
  initialActivityCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(initialNavCollapsed);
  const [activityCollapsed, setActivityCollapsed] = useState(initialActivityCollapsed);
  const pathname = usePathname();
  const router = useRouter();

  // The docked assistant column's width, published as `--assistant-w` so <main>
  // (and the bottom-right dock stack) shrink beside the open column. 0 whenever
  // the panel is minimised/closed or rendering as a full overlay.
  const { panel: assistantPanel, docked: assistantDocked } = useAssistantDock();
  const assistantW = assistantPanel === 'open' && assistantDocked ? '30rem' : '0rem';

  // Shell chrome — avatar, pending-approvals badge, onboarding gate — fetched
  // client-side so the layout stays data-free. Until it lands the avatar falls
  // back to a placeholder and the badge to 0 (the chrome renders immediately).
  const shellQuery = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<ShellData>('/api/shell'),
  });
  const userAvatar = shellQuery.data?.avatar ?? null;
  const pendingApprovals = shellQuery.data?.pendingApprovals ?? 0;

  // First-run gate: a logged-in but not-yet-onboarded user goes to the wizard
  // (outside the (app) group, so no redirect loop). Moved here from the server
  // layout so the shell makes no in-process DB read.
  useEffect(() => {
    if (shellQuery.data && !shellQuery.data.onboarded) router.replace('/onboarding');
  }, [shellQuery.data, router]);

  // Colour-theme sync: the DB copy is the cross-browser source of truth; the
  // localStorage the pre-paint script read is only this browser's cache. Adopt
  // the server value once per shell load (a later local change wins the session
  // and writes itself back through the provider). Unknown ids — a theme removed
  // from the list — are ignored rather than applied.
  const { colorTheme: activeColorTheme, adoptServerTheme } = useColorTheme();
  const adoptedTheme = useRef(false);
  useEffect(() => {
    if (adoptedTheme.current) return;
    const stored = shellQuery.data?.colorTheme;
    if (shellQuery.data === undefined) return;
    adoptedTheme.current = true;
    if (!stored || stored === activeColorTheme) return;
    if (!COLOR_THEMES.some((t) => t.id === stored)) return;
    adoptServerTheme(stored);
  }, [shellQuery.data, activeColorTheme, adoptServerTheme]);

  // Font sync — same shape as the colour theme: adopt the DB choices once per
  // shell load (the pre-paint script already applied this browser's cache; this
  // reconciles to the cross-browser source of truth). Unknown keys fall back to
  // the defaults inside adoptServerFonts.
  const { adoptServerFonts } = useFonts();
  const adoptedFonts = useRef(false);
  useEffect(() => {
    if (adoptedFonts.current) return;
    if (shellQuery.data === undefined) return;
    adoptedFonts.current = true;
    adoptServerFonts(shellQuery.data.fontLogo ?? null, shellQuery.data.fontTitle ?? null);
  }, [shellQuery.data, adoptServerFonts]);

  // Publish the asset-access token so `assetUrl()` can sign browser-native srcs
  // (<img>/<iframe>/download) for a detached client. No-op same-origin.
  useEffect(() => {
    setAssetToken(shellQuery.data?.assetToken);
  }, [shellQuery.data?.assetToken]);

  // Close the drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Tally which primary menu the user landed on, so the footer quick-menu can
  // rank by actual usage. Attributed to one canonical nav item (sub-routes fold
  // into their section); unmatched paths are ignored.
  useEffect(() => {
    const item = matchNavItem(pathname);
    if (item) recordNavVisit(item.href);
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

  // Keyboard shortcuts: ⌘/Ctrl+B toggles the nav, ⌘/Ctrl+J toggles Activity,
  // ⌘/Ctrl+K opens the search palette. Skipped while typing / editing so ⌘B
  // still bolds in the page editor and we don't steal keystrokes from inputs
  // (⌘K can still CLOSE the open palette — its own input would otherwise
  // swallow the toggle). (setState setters are stable, so the listener is
  // registered once.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'b' && k !== 'j' && k !== 'k') return;
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      if (k === 'k') {
        // Toggle from anywhere except a real editor/input — unless the input is
        // the palette's own, where ⌘K should still close it.
        if (typing && !t.closest('[data-slot=command-input-wrapper]')) return;
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if (typing) return;
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

  const body = (onNavigate?: () => void, collapsed = false) => (
    <>
      {contextCard}
      <UpdateBanner onNavigate={onNavigate} />
      <SidebarNav
        pendingApprovals={pendingApprovals}
        onNavigate={onNavigate}
        collapsed={collapsed}
      />
      <ChangelogLink onNavigate={onNavigate} />
    </>
  );

  return (
    <div
      className="group/shell h-screen bg-background"
      data-nav-collapsed={navCollapsed ? 'true' : 'false'}
      data-activity-collapsed={activityCollapsed ? 'true' : 'false'}
      style={
        {
          '--nav-w': navCollapsed ? '3.5rem' : '16rem',
          '--activity-w': activityCollapsed ? '3.5rem' : '20rem',
          '--assistant-w': assistantW,
          '--footer-h': '2.75rem',
        } as React.CSSProperties
      }
    >
      <Header
        email={email}
        userAvatar={userAvatar}
        siteName={shellQuery.data?.siteName ?? null}
        onMenuClick={() => setMobileOpen(true)}
        onSearchClick={() => setSearchOpen(true)}
      />

      {/* Global search palette — one instance for the whole shell, summoned by
            ⌘K or the header magnifier. */}
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />

      {/* Desktop sidebar — ends above the footer bar, which now owns the
            collapse toggle (see <FooterBar/>). */}
      <aside className="fixed top-0 bottom-[var(--footer-h)] left-0 z-30 hidden w-[var(--nav-w)] flex-col border-r bg-sidebar pt-16 transition-[width] duration-200 ease-in-out md:flex">
        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
          {body(undefined, navCollapsed)}
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

      {/* Content area. Own Suspense boundary: a page (children) that suspends
            during SSR would otherwise bubble to the route boundary, wrapping the
            whole shell — header included — in a streaming boundary that's absent
            at client hydration, which shifts every radix `useId` in the header
            and trips a hydration-id mismatch (intermittent: only when the server
            is slow enough to stream). Containing it here, below the header, keeps
            the header's tree-context symmetric. Same rationale as UsageCard's
            boundary in layout.tsx. */}
      <main className="fixed inset-0 top-16 bottom-[var(--footer-h)] overflow-y-auto scrollbar-thin transition-[left,right] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[calc(var(--activity-w)+var(--assistant-w))]">
        <Suspense fallback={null}>{children}</Suspense>
      </main>

      {/* The full assistant as a content-area overlay — fills the same box as
            <main>, above every route, summoned from anywhere by the bubble/⌘I. */}
      <AssistantPanel />

      {/* Marker pick mode — highlights markable rows + intercepts their clicks
            while picking; renders nothing otherwise. */}
      <PickMode />

      {/* Headless: toasts a blocked run's question the moment it arrives, with
            an "Answer" action that opens the assistant. Renders nothing. */}
      <PendingQuestionWatcher />

      {/* Upload dock — floats just above the footer bar. Inside the shell so it
            inherits --activity-w (sits left of the activity rail) and persists
            across route changes. pointer-events-none lets clicks fall through the
            gaps; the dock re-enables its own. */}
      <div className="pointer-events-none fixed bottom-[calc(var(--footer-h)+1rem)] right-4 z-40 flex w-96 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-3 lg:right-[calc(var(--activity-w)+var(--assistant-w)+1rem)]">
        <UploadDock />
      </div>

      {/* Footer toolbar: sidebar collapse · quick-menu · Highlight/Assistant ·
            activity collapse. Full width, owns every shell collapse control. */}
      <FooterBar
        navCollapsed={navCollapsed}
        onToggleNav={toggleNav}
        activityCollapsed={activityCollapsed}
        onToggleActivity={toggleActivity}
      />
    </div>
  );
}
