'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { AssistantThreadClient } from '@/app/(app)/assistant/assistant-thread-client';
import { useAssistantDock } from './assistant-dock';

/**
 * The full assistant, in one of two shapes:
 *
 *  - **Overlay** (default): fills the same inset box as the shell's `<main>`
 *    (below the header, between the nav rail and the live column), so it reads
 *    like any other screen rather than a floating window — yet it lives above
 *    every route, so it's available everywhere and minimises to the bubble.
 *
 *  - **Docked column** (editor surfaces, lg+): when the open screen pins a node
 *    (a page / table / app is open) the panel docks as a right-hand column and
 *    `<main>` shrinks beside it (the shell publishes `--assistant-w`), so the
 *    editor stays visible while you chat — gutter marks, live edits, and review
 *    highlights are all seen as they happen, like the old dedicated assist
 *    panels. Below lg it falls back to the overlay.
 *
 * It mounts in the background on page load (hidden via display:none until
 * `open`), so the thread warms immediately, the composer exists from the start
 * (a marker selection always has somewhere to land), and opening is instant.
 * It then stays mounted, so the transcript, scroll position, composer draft,
 * and any live turn stream survive a minimise/restore without a re-fetch.
 * `Esc` minimises.
 */
export function AssistantPanel() {
  const { panel, activeAgentSlug, minimize, docked } = useAssistantDock();

  // Esc minimises while open.
  useEffect(() => {
    if (panel !== 'open') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        minimize();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, minimize]);

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 top-16 z-20 bg-background transition-[left,right,width] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[var(--activity-w)]',
        // Docked: a right column beside the visible editor (lg+ only — below lg
        // the overlay geometry above still applies).
        docked && 'lg:left-auto lg:w-[var(--assistant-w)] lg:border-l lg:border-border',
        panel !== 'open' && 'hidden',
      )}
      aria-hidden={panel !== 'open'}
    >
      <AssistantThreadClient slugHint={activeAgentSlug} />
    </div>
  );
}
