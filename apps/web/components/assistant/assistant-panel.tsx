'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { AssistantThreadClient } from '@/app/(app)/assistant/assistant-thread-client';
import { useAssistantDock } from './assistant-dock';

/**
 * The full assistant as a content-area overlay. It fills the same inset box as
 * the shell's `<main>` (below the header, between the nav rail and the live
 * column), so it reads like any other screen rather than a floating window — yet
 * it lives above every route, so it's available everywhere and minimises to the
 * bubble.
 *
 * It mounts in the background on page load (hidden via display:none until
 * `open`), so the thread warms immediately, the composer exists from the start
 * (a marker selection always has somewhere to land), and opening is instant.
 * It then stays mounted, so the transcript, scroll position, and any live turn
 * stream survive a minimise/restore without a re-fetch. `Esc` minimises.
 */
export function AssistantPanel() {
  const { panel, activeAgentSlug, minimize } = useAssistantDock();

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
        'fixed inset-x-0 bottom-0 top-16 z-20 bg-background transition-[left,right] duration-200 ease-in-out md:left-[var(--nav-w)] lg:right-[var(--activity-w)]',
        panel !== 'open' && 'hidden',
      )}
      aria-hidden={panel !== 'open'}
    >
      <AssistantThreadClient slugHint={activeAgentSlug} />
    </div>
  );
}
