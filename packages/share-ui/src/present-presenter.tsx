'use client';

/**
 * Public presenter for a SHARED Present canvas (docs/proposals/
 * canvas-files.md 7.2): the canvas live, full screen (h-dvh, no share
 * shell), always the latest save, with a small floating pill that labels the
 * page as a shared canvas and carries Replay and Full screen (the pill stays
 * on screen in full screen). The frame
 * ticket and the frame document come from /s/<token>/canvas, which re-checks
 * the link on every load. The canvas's `mantle.data` calls are refused here:
 * a link reads or writes no saved data.
 */
import { useRef, useState } from 'react';
import { Maximize, RotateCcw } from 'lucide-react';
import { CanvasSandbox } from './canvas-sandbox';
import type { ShareViewPayload } from './view-payload';

export function PresentPresenter({
  view,
  token,
}: {
  view: Extract<ShareViewPayload, { kind: 'present' }>;
  token: string;
}) {
  // Full screen takes the whole presenter, pill included: the label that
  // says this is a shared canvas never leaves the screen.
  const stage = useRef<HTMLDivElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const button =
    'inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div ref={stage} className="relative h-dvh w-full bg-background">
      <CanvasSandbox
        presentId={view.presentId}
        apiBase={`/s/${encodeURIComponent(token)}/canvas`}
        title={view.title || 'Shared canvas'}
        reloadKey={reloadKey}
        dataApi={false}
      />
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-full border border-border bg-background/85 py-1 pl-3 pr-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
        <span className="max-w-[40vw] truncate">Shared canvas</span>
        <button
          type="button"
          className={button}
          aria-label="Replay"
          title="Replay"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className={button}
          aria-label="Full screen"
          title="Full screen"
          onClick={() => void stage.current?.requestFullscreen?.().catch(() => undefined)}
        >
          <Maximize className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
