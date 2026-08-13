'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { Button } from '@mantle/web-ui/ui/button';
import { helpTopicForPath } from '@mantle/web-ui/layout/help-topics';
import { useHelpRail } from './help-rail-context';

/**
 * The help column. Geometry mirrors the docked assistant panel: a fixed column
 * between the content and the Activity rail, ending at the footer bar — so the
 * two read as siblings rather than two different ideas of "a panel".
 *
 * Below `lg` there is no room for a third column, so it takes the same
 * full-width-overlay geometry the assistant uses at that breakpoint.
 *
 * The body is dynamically imported: opening the rail is what pulls in
 * react-markdown and the content, so a screen still costs nothing extra until
 * the reader asks.
 */
const HelpRailBody = dynamic(() => import('./help-rail-body').then((m) => m.HelpRailBody), {
  ssr: false,
});

export function HelpRail() {
  const pathname = usePathname();
  const topic = helpTopicForPath(pathname ?? '/');
  const { open, everOpened, close } = useHelpRail();

  // Never mounted until first opened; once mounted it stays, so reopening is
  // instant and the fetched topic stays cached.
  if (!everOpened || !topic) return null;

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 top-[var(--top-bar-h)] z-20 flex flex-col border-border transition-[left,right,width] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[calc(var(--activity-w)+var(--assistant-w))]',
        'lg:left-auto lg:w-[var(--help-w)] lg:border-l',
        // The wash: same family as the header's, so the column reads as shell
        // chrome rather than content. Built from `primary`, so it re-tints with
        // every theme instead of pinning a colour.
        'isolate bg-background bg-gradient-to-b from-primary/10 via-background to-background',
        !open && 'hidden',
      )}
      aria-hidden={!open}
      role="complementary"
      aria-label="About this screen"
    >
      {/* A fine grid that dissolves downward into the wash. Ruled with
          `--border` (a theme var, never a literal) and masked to fade out, so on
          a dark theme it reads as a faint blueprint and on a light one as barely
          -there paper. Decorative only — hidden from the accessibility tree. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.55), transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.55), transparent)',
        }}
      />

      <div className="relative flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <h2 className="truncate text-sm font-semibold">About this screen</h2>
        <Button variant="ghost" size="icon" className="size-7" onClick={close} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
        <HelpRailBody topic={topic} />
      </div>
    </div>
  );
}
