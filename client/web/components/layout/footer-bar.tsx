'use client';

import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import {
  AssistantButton,
  AssistantDockToggle,
  HighlightButton,
} from '@/components/assistant/assistant-dock';
import { HelpLauncher } from '@/components/help/help-launcher';

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

      {/* Persistent Mantle brand tucked into the bottom-left, in the sidebar's
          column, just right of the collapse (minimize) toggle. Uses
          `.wordmark-brand` (--font-brand, the product's own face) — NOT
          --font-wordmark — so it always reads "mantle" in Mantle's typeface
          regardless of the owner's chosen wordmark font or site name. Shown
          with the sidebar (md+). */}
      <div className="mx-1 hidden h-5 w-px bg-border md:block" aria-hidden />
      <span className="wordmark-brand hidden select-none px-0.5 text-xl leading-none text-primary-ink md:inline-block">
        mantle
      </span>

      {/* End: the two launchers, then the activity-rail collapse (rail is lg+). */}
      <div className="ml-auto flex items-center gap-1">
        {/* Per-screen help — left of the content launchers, so the three
            column-openers read as one group. Renders nothing on a route
            without a help topic. */}
        <HelpLauncher />
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
      </div>
    </footer>
  );
}
