'use client';

/**
 * Shared "what is the specialist doing right now" feedback for the in-surface
 * Assist panels (/pages, /tables, /apps, /dev-tools).
 *
 * - `useAssistStage(url, active)` polls the stage endpoint while a run is in
 *   flight and returns the latest label ("Editing the page…", "Building…", …).
 * - `<SpecialistWorking stage agentName />` is the animated indicator: a pinging
 *   sparkle + bouncing dots + the live label, falling back to "{name} is
 *   working…" between recognisable stages (never a blank).
 *
 * Generalised from the original /apps-only versions
 * (components/app-sandbox/use-assist-stage.ts + AppsmithWorking).
 */

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';

/**
 * Poll a specialist's current activity label while an Assist run is in flight.
 *
 * While `active`, polls `url` on a self-scheduling ~900ms timer (no overlap, so
 * polls never pile up when latency is high over Tailscale) and returns the
 * latest label. Returns null when idle or between recognisable stages — the
 * caller falls back to the "{name} is working…" copy.
 */
export function useAssistStage(url: string, active: boolean): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setLabel(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { label?: string | null };
          setLabel(data.label ?? null);
        }
      } catch {
        // Network blip — keep the last label, try again next tick.
      }
      if (!cancelled) timer = setTimeout(poll, 900);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, active]);

  return label;
}

/**
 * In-flight indicator for a specialist Assist run: an animated badge plus the
 * live stage label, falling back to "{agentName} is working…" between stages.
 * Slots into either a single-reply panel (/apps) or a chat message list
 * (/pages, /tables, /dev-tools) — render it where the pending state shows.
 */
export function SpecialistWorking({
  stage,
  agentName,
}: {
  stage: string | null;
  agentName: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-primary/30 bg-primary/10 p-2.5 text-xs shadow-sm">
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/30" />
        <Sparkles className="relative size-3.5 text-primary" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {stage ?? `${agentName} is working…`}
      </span>
      <span className="flex items-end gap-0.5" aria-hidden>
        {[0, 150, 300].map((d) => (
          <span
            key={d}
            className="size-1 animate-bounce rounded-full bg-primary"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </span>
    </div>
  );
}
