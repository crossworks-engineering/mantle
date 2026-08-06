'use client';

import * as React from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { Button } from '@mantle/web-ui/ui/button';
import { DISPLAY_FONTS, fontFamilyValue, type DisplayFont } from '@mantle/web-ui/display-fonts';

/**
 * One font selector — the sample text rendered in each candidate face (the live
 * preview), the family name beneath it, prev/next arrows to cycle, click to
 * select. Selecting calls `onChange` (the FontProvider), which repaints the
 * wordmark/title instantly.
 *
 * Used three times on the Appearance screen — wordmark, peer name, and the
 * INTERFACE font — as three equal columns. The list is a prop for exactly that
 * reason: the interface font deserves the same treatment as the two display
 * faces, and a second near-identical picker would have been a copy that drifts.
 * Adding a font to either registry needs no change here.
 */
export function FontPicker({
  title,
  sample,
  value,
  onChange,
  fonts = DISPLAY_FONTS,
  unbounded = false,
}: {
  title: string;
  /** Text shown in each font as the preview (e.g. the site name for the wordmark). */
  sample: string;
  value: string;
  onChange: (key: string) => void;
  /** Which registry to offer. Defaults to the display faces (wordmark / peer
   *  name); the interface picker passes UI_FONTS. */
  fonts?: DisplayFont[];
  /** Let the list run its FULL height with no inner scroller, so the page is
   *  the only thing that scrolls. A capped, scrollable column nested inside a
   *  scrollable page gives you two scrollbars fighting over the same gesture,
   *  which reads as broken. Used by the Appearance brand panel, where the whole
   *  face library should just read down the page. */
  unbounded?: boolean;
}) {
  const idx = Math.max(
    0,
    fonts.findIndex((f) => f.key === value),
  );
  const step = (dir: number) => {
    const n = (idx + dir + fonts.length) % fonts.length;
    const next = fonts[n];
    if (next) onChange(next.key);
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => step(-1)}
            aria-label={`Previous ${title.toLowerCase()} font`}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => step(1)}
            aria-label={`Next ${title.toLowerCase()} font`}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'space-y-1.5 pr-1',
          // Only the compact form scrolls itself; unbounded defers to the page.
          !unbounded && 'scrollbar-thin max-h-72 overflow-y-auto',
        )}
      >
        {fonts.map((f) => {
          const active = f.key === value;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => onChange(f.key)}
              aria-pressed={active}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-lg border p-2 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent/40',
              )}
            >
              <span className="min-w-0 flex-1">
                {/* Clip WIDTH only (overflow-x-clip, bounded by the row) and let
                    the glyph HEIGHT overflow (overflow-y-visible) + a taller line
                    box (leading-normal) + py so swashy script/display faces show
                    their ascenders/descenders instead of being shaved — plain
                    `truncate` (overflow:hidden) clipped them. */}
                <span
                  className="block overflow-x-clip overflow-y-visible whitespace-nowrap py-1 text-xl leading-normal text-foreground"
                  style={{ fontFamily: fontFamilyValue(f.key) ?? undefined }}
                >
                  {sample}
                </span>
                <span className="mt-1 block truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                  {f.label}
                  {/* UI faces carry a shelf (sans / mono / character); display
                      faces don't, and get nothing rather than a filler word. */}
                  {f.category ? ` · ${f.category}` : ''}
                </span>
              </span>
              {active && <Check className="size-4 shrink-0 text-primary-ink" aria-hidden />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
