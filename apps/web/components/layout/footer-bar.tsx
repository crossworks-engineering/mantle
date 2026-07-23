'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { cn } from '@/lib/utils';
import { navItemMatches } from './nav-items';
import { useTopNavItems } from '@/lib/nav-usage';
import {
  AssistantButton,
  AssistantDockToggle,
  HighlightButton,
} from '@/components/assistant/assistant-dock';

/** Compact icon toggle styled to match the footer's quick-menu links. */
function ToggleButton({
  onClick,
  label,
  title,
  className,
  children,
}: {
  onClick: () => void;
  label: string;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      className={cn(
        'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Full-width bottom status bar. Groups every shell control in one logical strip:
 *  - start: the sidebar collapse toggle (sits under the sidebar it controls),
 *  - centre: the user's five most-used menus (ranked from local usage),
 *  - end: the Highlight-content + Assistant launchers, then the activity-rail
 *    collapse toggle (under the activity rail it controls).
 * The height is published as `--footer-h` on the shell root; every full-height
 * region (sidebar, activity rail, main, assistant panel, mail, fleet) ends at
 * `bottom-[var(--footer-h)]` so nothing hides behind the bar.
 */
export function FooterBar({
  navCollapsed,
  onToggleNav,
  activityCollapsed,
  onToggleActivity,
}: {
  navCollapsed: boolean;
  onToggleNav: () => void;
  activityCollapsed: boolean;
  onToggleActivity: () => void;
}) {
  const pathname = usePathname();
  const top = useTopNavItems(5);

  return (
    <footer
      className="fixed inset-x-0 bottom-0 z-30 flex h-[var(--footer-h)] items-center gap-2 border-t border-border bg-sidebar px-2"
      aria-label="Toolbar"
    >
      {/* Start: sidebar collapse (desktop sidebar is md+). */}
      <ToggleButton
        onClick={onToggleNav}
        label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={navCollapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
        className="hidden md:flex"
      >
        {navCollapsed ? (
          <PanelLeft className="size-4" aria-hidden />
        ) : (
          <PanelLeftClose className="size-4" aria-hidden />
        )}
      </ToggleButton>

      {/* Centre: top-used menus, absolutely centred so the flanking clusters
          never shift them off-centre. Hidden on narrow screens. */}
      <nav
        className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 md:flex"
        aria-label="Frequent pages"
      >
        {top.map((item) => {
          const active = navItemMatches(item, pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              title={item.name}
              className={cn(
                'pointer-events-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="hidden lg:inline">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* End: the two launchers, then the activity-rail collapse (rail is lg+). */}
      <div className="ml-auto flex items-center gap-1">
        <HighlightButton />
        <AssistantButton />
        {/* Full-display ⇄ side-column toggle — only while the assistant is open. */}
        <AssistantDockToggle />
        <div className="mx-1 hidden h-5 w-px bg-border lg:block" aria-hidden />
        <ToggleButton
          onClick={onToggleActivity}
          label={activityCollapsed ? 'Expand activity' : 'Collapse activity'}
          title={activityCollapsed ? 'Expand activity (⌘J)' : 'Collapse activity (⌘J)'}
          className="hidden lg:flex"
        >
          {/* Same glyphs as the sidebar toggle, mirrored horizontally so the two
              collapse controls read as a symmetric pair. */}
          {activityCollapsed ? (
            <PanelLeft className="size-4 -scale-x-100" aria-hidden />
          ) : (
            <PanelLeftClose className="size-4 -scale-x-100" aria-hidden />
          )}
        </ToggleButton>

        {/* Persistent Mantle brand, pinned to the corner. Deliberately uses
            --font-logo (the base Bukhari face) directly — NOT --font-wordmark —
            so it always reads "mantle" in Bukhari even when the owner picks a
            different wordmark font or renames the site (the header wordmark is
            theirs; this stays ours). Hidden on the tightest screens. */}
        <div className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
        <span
          className="hidden select-none pr-1 pl-0.5 text-xl leading-none text-primary sm:inline-block"
          style={{ fontFamily: 'var(--font-logo)' }}
        >
          mantle
        </span>
      </div>
    </footer>
  );
}
