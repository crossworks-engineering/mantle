import React from 'react';
import { cn } from '@mantle/web-ui/lib/utils';
import { Scrollable, type ScrollbarStyle } from '@mantle/web-ui/ui/scrollable';

/**
 * Two-column list/detail layout (adopted from the DFM "FleetLayout").
 *
 *  - Left column: scrollable list (email list, notes, events, …)
 *  - Right column: detail/content for the selected item (desktop only)
 *
 * Renders a fixed overlay filling the shell's content area — it offsets
 * for the header (top-16) and the collapsible sidebar / live column via
 * the shell's `--nav-w` / `--activity-w` CSS vars, so it reflows with them.
 * Each column scrolls independently while the page itself never scrolls.
 * Below lg the right column hides and the list takes the full width (mobile
 * uses route/query state to swap to a detail view).
 */
export function FleetLayout({
  header,
  left,
  right,
  scrollbar = 'thin',
  className,
  leftClassName = 'flex-1 lg:flex-none lg:w-1/2',
  rightClassName = 'lg:w-1/2',
}: {
  header?: React.ReactNode;
  left: React.ReactNode;
  right: React.ReactNode;
  scrollbar?: ScrollbarStyle;
  className?: string;
  /** Width/flex classes for the left list column. */
  leftClassName?: string;
  /** Width classes for the right detail column. */
  rightClassName?: string;
}) {
  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-[var(--footer-h)] top-16 z-10 flex flex-col overflow-hidden bg-background transition-[left,right] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[var(--activity-w)]',
        className,
      )}
    >
      {header && <div className="flex-shrink-0">{header}</div>}

      <div className="flex flex-1 gap-4 overflow-hidden px-4 py-4 md:px-6">
        <Scrollable scrollbar={scrollbar} className={cn('pr-1', leftClassName)}>
          {left}
        </Scrollable>

        <div className={cn('hidden min-h-0 flex-col lg:flex', rightClassName)}>
          <Scrollable scrollbar={scrollbar} className="h-full">
            {right}
          </Scrollable>
        </div>
      </div>
    </div>
  );
}
