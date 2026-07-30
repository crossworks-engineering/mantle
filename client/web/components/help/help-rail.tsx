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
        'fixed inset-x-0 bottom-[var(--footer-h)] top-16 z-20 flex flex-col border-border bg-background transition-[left,right,width] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[calc(var(--activity-w)+var(--assistant-w))]',
        'lg:left-auto lg:w-[var(--help-w)] lg:border-l',
        !open && 'hidden',
      )}
      aria-hidden={!open}
      role="complementary"
      aria-label="About this screen"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 className="truncate text-sm font-semibold">About this screen</h2>
        <Button variant="ghost" size="icon" className="size-7" onClick={close} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
        <HelpRailBody topic={topic} />
      </div>
    </div>
  );
}
