'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, upgradeOwnerCookie } from '@mantle/web-ui/api-fetch';
import { useColorTheme } from '@mantle/web-ui/color-theme-provider';
import { useFonts } from '@mantle/web-ui/font-provider';
import { COLOR_THEMES } from '@mantle/web-ui/lib/themes';
import { setAssetToken } from '@mantle/web-ui/asset-url';
import { maybeRefreshToken } from '@mantle/web-ui/token-refresh';
import { AreaBackdrop } from '@mantle/web-ui/area-backdrop';
import { BrandBlock } from '@/components/layout/rail/brand-block';
import { RailControls } from '@/components/layout/rail/rail-controls';
import { RailToolbar } from '@/components/layout/rail/rail-toolbar';
import { MobileBar } from '@/components/layout/rail/mobile-bar';
import { SidebarNav } from '@/components/layout/sidebar-nav';
import { ChangelogLink } from '@/components/layout/changelog-link';
import { UpdateBanner } from '@/components/layout/update-banner';
import { LiveColumn } from '@/components/layout/live-column';
import { Sheet, SheetContent, SheetTitle } from '@mantle/web-ui/ui/sheet';
import { ToastProvider } from '@mantle/web-ui/ui/toast';
import { PageTitleProvider } from '@/components/layout/page-title';
import { UploadProvider, UploadDock } from '@/components/uploads/upload-provider';
import { AssistantDockProvider, useAssistantDock } from '@/components/assistant/assistant-dock';
import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { HelpRailProvider, useHelpRail } from '@/components/help/help-rail-context';
import { HelpRail } from '@/components/help/help-rail';
import { PendingQuestionWatcher } from '@/components/pending/question-watcher';
import { DesktopBridge } from '@/components/desktop/desktop-bridge';
import { PickMode } from '@/components/assistant/pick-mode';
import { ZenModeContext } from '@/components/layout/zen-mode';
import { recordNavVisit } from '@/lib/nav-usage';
import { matchNavItem } from '@mantle/web-ui/layout/nav-items';
import { SearchPalette } from '@/components/search/search-palette';

/**
 * App shell — TWO fixed regions, the left rail and the right live column,
 * framing a scrollable content area that runs the full height of the window.
 * The rail collapses into a Sheet drawer below md. The server-rendered
 * context+cost card is passed in as a prop.
 *
 * NO HEADER, NO FOOTER BAR. Both were full-width strips — 4rem and 2.75rem,
 * 108px of every screen at every window size — holding roughly a dozen
 * controls that each occupied a few hundred pixels of a bar spanning thousands.
 * They now live in the left rail (components/layout/rail/), which was already
 * on screen and had height to spare: identity at the top, account/theme/search
 * under it, the nav in the middle, the four launchers at the foot. The wider
 * the display, the better that trade gets, which is the whole reason for it.
 *
 * What survives across the top is `<MobileBar/>`, below md ONLY, where the rail
 * is a closed drawer and a phone would otherwise have no way to open it.
 *
 * Collapse: the left nav and right Activity column each collapse to an icon
 * rail. Their widths are published as the `--nav-w` / `--activity-w` CSS
 * variables on the shell root, which every framing element (rail, main,
 * FleetLayout, mail shell, live column) offsets against — so one state flip
 * reflows the whole shell. The top offset is the same idea in the other axis,
 * but it is breakpoint-dependent, so `--top-bar-h` is set in globals.css rather
 * than inline here. Collapsed state is also mirrored as
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
  /** Who this browser is signed in AS (the actor, not the anchor account) —
   *  the rail's profile row. Both null on a brain that stores neither. */
  displayName?: string | null;
  email?: string | null;
  /** Custom wordmark (Settings → Profile → Site name); null ⇒ "mantle". */
  siteName: string | null;
  /** This brain's peer name (Settings → Profile → Peer name), the brand block's
   *  second line; null ⇒ the line is not rendered. */
  peerName: string | null;
  /** Brand logo cache-busting version (Settings → Appearance → Logo); null ⇒
   *  no logo, the siteName wordmark renders. Src is /api/appearance/logo. */
  logoVersion: string | null;
  logoDarkVersion?: string | null;
  /** The DB-stored colour theme (the cross-browser source of truth); null ⇒
   *  never saved. Adopted once per shell load. */
  colorTheme: string | null;
  /** DB-stored font keys + sizes for the four slots (Settings → Appearance →
   *  Fonts); null ⇒ the defaults. Adopted once per shell load, like the colour
   *  theme — face and size together, since they are one choice. */
  fontLogo: string | null;
  fontTitle: string | null;
  fontUi: string | null;
  fontProse: string | null;
  fontSize: string | null;
  fontLogoSize: string | null;
  fontTitleSize: string | null;
  fontProseSize: string | null;
  /** Short-lived asset-access token for browser-native srcs in detached mode
   *  (see lib/asset-url). Absent/ignored same-origin. */
  assetToken?: string;
};

export function AppShell(props: {
  contextCard: React.ReactNode;
  initialNavCollapsed?: boolean;
  initialActivityCollapsed?: boolean;
  /** Nav groups the user last left unfolded, seeded from the cookie so a
   *  folded group never flashes open on first paint. */
  initialExpandedGroups?: string[];
  children: React.ReactNode;
}) {
  // Providers only — the frame itself lives in <ShellFrame/>, which sits INSIDE
  // AssistantDockProvider and HelpRailProvider so it can read both dock states
  // (each open column publishes its width to the frame's CSS vars).
  return (
    <ToastProvider>
      <PageTitleProvider>
        <UploadProvider>
          <AssistantDockProvider>
            <HelpRailProvider>
              <ShellFrame {...props} />
            </HelpRailProvider>
          </AssistantDockProvider>
        </UploadProvider>
      </PageTitleProvider>
    </ToastProvider>
  );
}

function ShellFrame({
  contextCard,
  initialNavCollapsed = false,
  initialActivityCollapsed = true,
  initialExpandedGroups = [],
  children,
}: {
  contextCard: React.ReactNode;
  initialNavCollapsed?: boolean;
  initialActivityCollapsed?: boolean;
  initialExpandedGroups?: string[];
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
  // The help column's width, published as `--help-w` so <main> shrinks beside it
  // exactly as it does for the assistant. 0 whenever the rail is closed.
  const { open: helpOpen } = useHelpRail();
  const helpW = helpOpen ? '22rem' : '0rem';

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
  // shell load, reconciling to the cross-browser source of truth in case another
  // browser changed the brand mid-session. Unknown and absent keys are ignored
  // inside adoptServerFonts, so a slot the server has never stored keeps
  // whatever the server-rendered document already painted.
  const { adoptServerFonts } = useFonts();
  const adoptedFonts = useRef(false);
  useEffect(() => {
    if (adoptedFonts.current) return;
    if (shellQuery.data === undefined) return;
    adoptedFonts.current = true;
    adoptServerFonts(
      {
        logo: shellQuery.data.fontLogo ?? null,
        title: shellQuery.data.fontTitle ?? null,
        ui: shellQuery.data.fontUi ?? null,
        prose: shellQuery.data.fontProse ?? null,
      },
      {
        ui: shellQuery.data.fontSize ?? null,
        logo: shellQuery.data.fontLogoSize ?? null,
        title: shellQuery.data.fontTitleSize ?? null,
        prose: shellQuery.data.fontProseSize ?? null,
      },
    );
  }, [shellQuery.data, adoptServerFonts]);

  // Publish the asset-access token so `assetUrl()` can sign browser-native srcs
  // (<img>/<iframe>/download) for a detached client. No-op same-origin.
  useEffect(() => {
    setAssetToken(shellQuery.data?.assetToken);
  }, [shellQuery.data?.assetToken]);

  // Same-origin bearer→cookie upgrade, once per shell load. Owners signed in
  // before the origin predicate was fixed hold ONLY a localStorage bearer, and
  // same-origin <img>/<iframe>/download srcs authenticate by COOKIE — they
  // can't carry a header. Fired here (not awaited) because the shell mounts
  // before any asset-bearing screen. No-op cross-origin and for cookie
  // sessions. See upgradeOwnerCookie.
  useEffect(() => {
    void upgradeOwnerCookie();
  }, []);

  // Split-client bearer upkeep, piggybacked on the shell boot round-trip:
  // rotate the stored token when <7d from expiry. No-op same-origin (no
  // stored bearer). See @mantle/web-ui/token-refresh.
  useEffect(() => {
    if (shellQuery.data) void maybeRefreshToken();
  }, [shellQuery.data]);

  // Close the drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Tally which primary menu the user landed on, so a collapsible nav group can
  // rank its folded HEAD by actual usage (see useGroupHead). Attributed to one
  // canonical nav item (sub-routes fold into their section); unmatched paths are
  // ignored.
  useEffect(() => {
    const item = matchNavItem(pathname);
    if (item) recordNavVisit(item.href);
  }, [pathname]);

  // Distraction-free ("focus") mode — hides all four chrome regions and gives
  // the content the whole viewport. Ephemeral by design (no cookie); the
  // floating exit button below is the way back.
  const [zen, setZen] = useState(false);
  const zenCtx = useMemo(() => ({ zen, toggle: () => setZen((v) => !v) }), [zen]);

  // Leaving the screen leaves focus mode. Four screens offer the toggle (the
  // Pages and Draw editors and their list previews); everywhere else has no way
  // OUT, so arriving there with the chrome hidden would be a trap. Note this
  // watches the PATHNAME: picking another row in a list writes a query param,
  // so reading one page after another in focus mode does not drop you out of
  // it, while navigating to a different screen does.
  useEffect(() => {
    setZen(false);
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

  // Who the profile row names. Undefined until /api/shell lands, at which point
  // the row fills in — it renders a neutral "Signed in" in the meantime rather
  // than reserving an empty slot.
  const identity = {
    displayName: shellQuery.data?.displayName ?? null,
    email: shellQuery.data?.email ?? null,
    avatar: userAvatar,
  };

  /**
   * The rail's contents, shared by the desktop aside and the mobile drawer.
   *
   * Three bands: pinned identity + controls at the top, ONE scroll region in
   * the middle (the nav is the only part long enough to need it, and a rail
   * that scrolls its own brand away loses the thing that tells you where you
   * are), then the pinned toolbar. `min-h-0` on the scroller is what stops the
   * flex column from growing past the viewport and taking the toolbar with it.
   */
  const body = (onNavigate?: () => void, collapsed = false, inDrawer = false) => (
    <>
      <BrandBlock
        siteName={shellQuery.data?.siteName ?? null}
        peerName={shellQuery.data?.peerName ?? null}
        logoVersion={shellQuery.data?.logoVersion ?? null}
        logoDarkVersion={shellQuery.data?.logoDarkVersion ?? null}
        inDrawer={inDrawer}
        onNavigate={onNavigate}
      />
      <RailControls
        identity={identity}
        onSearchClick={() => {
          onNavigate?.();
          setSearchOpen(true);
        }}
        onNavigate={onNavigate}
      />

      {/* `relative` is load-bearing: the menu backdrop is absolutely positioned
          and would otherwise paint OVER this in-flow content regardless of DOM
          order. Same reason the brand block and the toolbar carry it. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
        {contextCard}
        <UpdateBanner onNavigate={onNavigate} />
        <SidebarNav
          initialExpandedGroups={initialExpandedGroups}
          onRequestExpandRail={() => {
            if (!navCollapsed) return;
            setNavCollapsed(false);
            writeCookie(NAV_COOKIE, false);
          }}
          pendingApprovals={pendingApprovals}
          onNavigate={onNavigate}
          collapsed={collapsed}
        />
        <ChangelogLink onNavigate={onNavigate} />
      </div>

      <RailToolbar
        navCollapsed={navCollapsed}
        onToggleNav={toggleNav}
        showCollapse={!inDrawer}
        // The launchers open surfaces that live BEHIND the modal drawer
        // (assistant z-20, help z-20, pick-mode z-40 vs the Sheet's z-50), so
        // in the drawer every toolbar tap must also close it or the tap
        // appears dead. Not wired to navigation like the other bands' —
        // launchers don't navigate — hence its own prop.
        onLaunch={onNavigate}
      />
    </>
  );

  return (
    <ZenModeContext.Provider value={zenCtx}>
      <div
        // `mantle-shell` is the hook for `--top-bar-h` (globals.css): the top
        // offset is breakpoint-dependent, so unlike the widths below it cannot
        // be an inline style.
        className="mantle-shell group/shell h-screen bg-background"
        data-nav-collapsed={navCollapsed ? 'true' : 'false'}
        data-activity-collapsed={activityCollapsed ? 'true' : 'false'}
        data-zen={zen ? 'true' : 'false'}
        style={
          {
            // Focus mode zeroes every chrome offset — the SAME vars the whole
            // frame already positions against, so one flip reflows everything.
            '--nav-w': zen ? '0px' : navCollapsed ? '3.5rem' : '16rem',
            '--activity-w': zen ? '0px' : activityCollapsed ? '3.5rem' : '20rem',
            '--assistant-w': assistantW,
            '--help-w': helpW,
          } as React.CSSProperties
        }
      >
        {/* Below md only — see <MobileBar/>. Wide screens have no top chrome. */}
        {zen ? null : (
          <MobileBar
            identity={identity}
            siteName={shellQuery.data?.siteName ?? null}
            logoVersion={shellQuery.data?.logoVersion ?? null}
            logoDarkVersion={shellQuery.data?.logoDarkVersion ?? null}
            onMenuClick={() => setMobileOpen(true)}
            onSearchClick={() => setSearchOpen(true)}
          />
        )}

        {/* Global search palette — one instance for the whole shell, summoned by
            ⌘K or the header magnifier. */}
        <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />

        {/* The rail. Full window height now that nothing brackets it: it owns
            the brand, the account/theme/search controls, the nav and the
            launcher toolbar. Unmounted in focus mode. */}
        {zen ? null : (
          <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--nav-w)] flex-col border-r bg-sidebar transition-[width] duration-200 ease-in-out md:flex">
            {/* Generated backdrop for this area — renders nothing when Settings →
              Appearance has the menu switched off. See
              @mantle/web-ui/area-backdrop. */}
            <AreaBackdrop area="menu" />
            {body(undefined, navCollapsed)}
          </aside>
        )}

        {/* Mobile rail drawer — portaled outside the shell root, so it always
            renders expanded regardless of collapse state. Same three bands as
            the aside, so a phone gets every control a desktop has; `flex-col`
            + the body's own `min-h-0` scroller keep the toolbar pinned to the
            bottom of the sheet instead of scrolling away with the nav. */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          {/* `gap-0`: the sheet variant's base carries `gap-4`, which was inert
              while this was a block container and became LIVE when the drawer
              went `flex flex-col` — 1rem background seams between bands the
              desktop aside doesn't have. */}
          <SheetContent side="left" className="flex w-80 flex-col gap-0 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {body(() => setMobileOpen(false), false, true)}
          </SheetContent>
        </Sheet>

        {/* Right live-activity column */}
        {zen ? null : <LiveColumn collapsed={activityCollapsed} onToggle={toggleActivity} />}

        {/* Content area — now the full height of the window at md and up, which
            is what removing the two bars bought.

            Own Suspense boundary: a page (children) that suspends during SSR
            would otherwise bubble to the route boundary, wrapping the whole
            shell — chrome included — in a streaming boundary that's absent at
            client hydration, which shifts every radix `useId` in that chrome
            and trips a hydration-id mismatch (intermittent: only when the
            server is slow enough to stream). Containing it here, beside the
            chrome rather than around it, keeps the chrome's tree-context
            symmetric. Same rationale as UsageCard's boundary in layout.tsx. */}
        <main className="fixed inset-0 top-[var(--top-bar-h)] overflow-y-auto scrollbar-thin transition-[left,right] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[calc(var(--activity-w)+var(--assistant-w)+var(--help-w))]">
          <Suspense fallback={null}>{children}</Suspense>
        </main>

        {/* The full assistant as a content-area overlay — fills the same box as
            <main>, above every route, summoned from anywhere by the bubble/⌘I. */}
        <AssistantPanel />
        <HelpRail />

        {/* Marker pick mode — highlights markable rows + intercepts their clicks
            while picking; renders nothing otherwise. */}
        <PickMode />

        {/* Headless: toasts a blocked run's question the moment it arrives, with
            an "Answer" action that opens the assistant. Renders nothing. */}
        <PendingQuestionWatcher />
        <DesktopBridge />

        {/* Upload dock — floats in the bottom-right corner of the content area,
            which now runs to the bottom of the window. Inside the shell so it
            inherits --activity-w (sits left of the activity rail) and persists
            across route changes. pointer-events-none lets clicks fall through the
            gaps; the dock re-enables its own. */}
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-96 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-3 lg:right-[calc(var(--activity-w)+var(--assistant-w)+1rem)]">
          <UploadDock />
        </div>
      </div>
    </ZenModeContext.Provider>
  );
}
