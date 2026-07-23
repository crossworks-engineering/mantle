'use client';

import * as React from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DISPLAY_FONTS, fontFamilyValue } from '@/lib/display-fonts';

/**
 * One font selector — the sample text rendered in each candidate face (the live
 * preview), the family name beneath it, prev/next arrows to cycle, click to
 * select. Selecting calls `onChange` (the FontProvider), which repaints the
 * wordmark/title instantly. Used twice on the Appearance screen (wordmark +
 * title), driven off the shared `DISPLAY_FONTS` registry so adding a font here
 * needs no change to this component.
 */
export function FontPicker({
  title,
  sample,
  value,
  onChange,
}: {
  title: string;
  /** Text shown in each font as the preview (e.g. the site name for the wordmark). */
  sample: string;
  value: string;
  onChange: (key: string) => void;
}) {
  const idx = Math.max(
    0,
    DISPLAY_FONTS.findIndex((f) => f.key === value),
  );
  const step = (dir: number) => {
    const n = (idx + dir + DISPLAY_FONTS.length) % DISPLAY_FONTS.length;
    const next = DISPLAY_FONTS[n];
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

      <div className="scrollbar-thin max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {DISPLAY_FONTS.map((f) => {
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
                <span
                  className="block truncate text-xl leading-tight text-foreground"
                  style={{ fontFamily: fontFamilyValue(f.key) ?? undefined }}
                >
                  {sample}
                </span>
                <span className="mt-0.5 block truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                  {f.label}
                </span>
              </span>
              {active && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
