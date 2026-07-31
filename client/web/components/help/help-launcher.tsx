'use client';

import { usePathname } from 'next/navigation';
import { CircleQuestionMark } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { helpTopicForPath } from '@mantle/web-ui/layout/help-topics';
import { useHelpRail } from './help-rail-context';

/**
 * The footer launcher — sits left of the Highlight-content button, alongside
 * the other panel launchers, because that strip is where this shell keeps
 * "open a column" controls.
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
        'flex size-7 items-center justify-center rounded-md transition-colors',
        open
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      <CircleQuestionMark className="size-4" aria-hidden />
    </button>
  );
}
