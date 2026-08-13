'use client';

import { usePathname } from 'next/navigation';
import { CircleQuestionMark } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { helpTopicForPath } from '@mantle/web-ui/layout/help-topics';
import { useHelpRail } from './help-rail-context';

/**
 * The launcher in the left rail's bottom toolbar — left of Highlight content
 * and the Assistant, because that strip is where this shell keeps its "open a
 * column" controls.
 *
 * Still the only part of the help system in the default bundle: an icon, a
 * pathname lookup and a boolean. The rail and its content load on first open.
 */
export function HelpLauncher() {
  const pathname = usePathname();
  const topic = helpTopicForPath(pathname ?? '/');
  const { open, toggle } = useHelpRail();

  // No topic for this screen yet ⇒ no affordance. Coverage grows route by route
  // without a launcher that opens an empty column.
  if (!topic) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={open}
      aria-label={open ? 'Close about this screen' : 'About this screen'}
      title={open ? 'Close about this screen' : 'About this screen'}
      className={cn(
        // size-8 to match the toggles and launchers it sits beside; a lone
        // odd-sized control in a four-icon strip reads as a mistake.
        'flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        open
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      <CircleQuestionMark className="size-4" aria-hidden />
    </button>
  );
}
