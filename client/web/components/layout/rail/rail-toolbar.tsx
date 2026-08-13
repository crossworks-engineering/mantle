'use client';

import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { AssistantButton, HighlightButton } from '@/components/assistant/assistant-dock';
import { HelpLauncher } from '@/components/help/help-launcher';

/**
 * The strip at the foot of the rail, and the last of the old footer bar. Four
 * controls in the order they are reached for: collapse the rail, explain this
 * screen, pick content to hand over, talk to the assistant.
 *
 * Three icons and one label, not four of either. The Assistant is the anchor of
 * the strip and the only one worth a word at this width; naming all four would
 * need three rows, and naming none would leave a row of anonymous glyphs. At
 * icon-rail width the strip stacks and the label goes with it.
 *
 * The right rail's own collapse is NOT here. It moved into the Activity
 * column's header, where the control sits on the thing it controls — the old
 * footer spanned the whole window, so it could hold both; a 16rem column on the
 * far left cannot honestly own a toggle for a panel on the far right.
 */
export function RailToolbar({
  navCollapsed,
  onToggleNav,
  showCollapse = true,
  onLaunch,
}: {
  navCollapsed: boolean;
  onToggleNav: () => void;
  /** The mobile drawer has nothing to collapse to — it is open or it is gone. */
  showCollapse?: boolean;
  /** Drawer only: fired (capture phase) on any toolbar click, closing the
   *  drawer BEFORE the launcher's own handler opens its surface. The assistant
   *  panel (z-20), help rail (z-20) and pick mode (z-40) all render behind the
   *  modal Sheet (z-50), so a launcher tapped inside the open drawer would
   *  otherwise appear to do nothing. Capture runs first in the same dispatch,
   *  and React processes the whole queue before re-rendering, so the button's
   *  handler still fires after the drawer state flips. */
  onLaunch?: () => void;
}) {
  return (
    <div
      className="relative flex shrink-0 items-center gap-1 border-t border-sidebar-border px-3 py-2 group-data-[nav-collapsed=true]/shell:flex-col group-data-[nav-collapsed=true]/shell:px-2"
      aria-label="Shell controls"
      role="toolbar"
      onClickCapture={onLaunch}
    >
      {showCollapse && (
        <button
          type="button"
          onClick={onToggleNav}
          aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={navCollapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:bg-foreground/[0.06] hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          )}
        >
          {navCollapsed ? (
            <PanelLeft className="size-4" aria-hidden />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden />
          )}
        </button>
      )}

      <HelpLauncher />
      <HighlightButton />

      {/* Pushed to the far end of the row so the strip reads as "three utilities,
          then the thing you actually came for". In the stacked icon rail there is
          no far end, so the auto margin is dropped.

          `min-w-0` is what keeps this honest: at 16rem the four controls fill the
          row to the pixel, and the Assistant grows when a parked run needs an
          answer (the icon gains a count badge). Without a shrinkable end the
          strip would overflow the rail exactly when it most needs to be read.
          The label truncates instead; the badge never does. */}
      <span className="ml-auto min-w-0 group-data-[nav-collapsed=true]/shell:ml-0">
        <AssistantButton />
      </span>
    </div>
  );
}
