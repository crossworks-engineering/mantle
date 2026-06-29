'use client';

import { useEffect } from 'react';
import { SquareDashedMousePointer } from 'lucide-react';
import { useAssistantDock, type ContextKind } from './assistant-dock';

const KINDS: ReadonlySet<string> = new Set<ContextKind>([
  'file',
  'folder',
  'page',
  'note',
  'table',
  'journal',
  'task',
  'event',
]);

/**
 * Global marker pick layer. Active only while `picking`, it turns any element
 * carrying `data-mark-id` (rows on the content screens) into a context target:
 * a capture-phase document click intercepts the row's own handler and marks the
 * node instead. Misses fall straight through, so the left nav stays usable —
 * you navigate to a screen, then click its rows. Multi-pick: it stays on until
 * you dismiss it (the marker bubble, the Done button, or Esc).
 *
 * The highlight itself is pure CSS, keyed off `body[data-picking]` (globals.css).
 */
export function PickMode() {
  const { picking, stopPicking, attachContext, pendingContext, agentName } = useAssistantDock();

  useEffect(() => {
    if (!picking) return;
    document.body.dataset.picking = 'true';

    const onClick = (e: MouseEvent) => {
      const start = e.target as HTMLElement | null;
      const el = start?.closest<HTMLElement>('[data-mark-id]');
      if (!el) return; // not a markable row — let the click do its normal thing
      const id = el.dataset.markId;
      if (!id) return;
      // Intercept BEFORE the row's own onClick (e.g. openFile) so picking never
      // also navigates into the item.
      e.preventDefault();
      e.stopPropagation();
      const kind = el.dataset.markKind;
      attachContext({
        id,
        kind: kind && KINDS.has(kind) ? (kind as ContextKind) : 'file',
        label: el.dataset.markLabel?.trim() || id,
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopPicking();
      }
    };

    document.addEventListener('click', onClick, true); // capture — beats React's root listener
    window.addEventListener('keydown', onKey);
    return () => {
      delete document.body.dataset.picking;
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [picking, attachContext, stopPicking]);

  if (!picking) return null;
  const count = pendingContext.length;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-b-lg border border-t-0 border-border bg-card px-4 py-2 text-sm shadow-lg">
        <SquareDashedMousePointer className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="text-foreground">
          Click items to send to {agentName}
          {count > 0 && <span className="text-muted-foreground"> · {count} selected</span>}
        </span>
        <button
          type="button"
          onClick={stopPicking}
          className="ml-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          Done
          <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            Esc
          </kbd>
        </button>
      </div>
    </div>
  );
}
