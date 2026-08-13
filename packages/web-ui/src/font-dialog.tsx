'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from './lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import {
  FONT_LIBRARY,
  FONT_SHELVES,
  FONT_SIZES,
  axisCount,
  fontFamilyValue,
  type FontFace,
  type FontShelf,
  type FontSize,
} from './display-fonts';
import { useFonts, type FontSlot } from './font-provider';

/**
 * The font selector — ONE dialog, opened from all four rows of Settings →
 * Appearance (interface, wordmark, peer name, Pages/Notes).
 *
 * It is one component rather than four because the only things that differ per
 * slot are the sample text and the copy: the library, the shelves, the sizes and
 * the apply-on-click behaviour are identical, and four near-identical pickers
 * is how they drift. The previous screen already learned this the small way
 * (one FontPicker rendered three times); this keeps it while moving the list
 * off the page, which is what makes room for a library this size.
 *
 * Changes apply IMMEDIATELY and persist fire-and-forget — there is no Save. The
 * page behind the dialog repaints as you click, which is the only honest way to
 * choose a typeface, and nothing here is destructive enough to need confirming.
 */
export function FontDialog({
  slot,
  title,
  description,
  sample,
  open,
  onOpenChange,
}: {
  slot: FontSlot;
  /** Dialog heading — the section's name, e.g. "Pages and Notes". */
  title: string;
  /** One line on what this slot actually affects. */
  description: string;
  /** Text rendered in each candidate face. The brain's real content where there
   *  is any (its site name, its peer name), so the preview shows the decision
   *  being made rather than a pangram standing in for it. */
  sample: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { fonts, sizes, setFont, setSize } = useFonts();
  const [shelf, setShelf] = React.useState<FontShelf | 'all'>('all');

  const active = fonts[slot];
  const size = sizes[slot];

  // 'inherit' means "follow the interface font", which the interface font
  // cannot do. It is also pinned above the shelves rather than filed under one:
  // it is a relationship, not a typeface.
  const inherit = slot === 'ui' ? undefined : FONT_LIBRARY.find((f) => f.key === 'inherit');
  const faces = FONT_LIBRARY.filter(
    (f) => f.key !== 'inherit' && (shelf === 'all' || f.shelf === shelf),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Size
          </h3>
          <ToggleGroup
            type="single"
            variant="outline"
            value={size}
            // Radix clears the value when the active item is re-clicked; a size
            // is never "none", so an empty payload is ignored rather than
            // resolved (which would silently snap the slot back to medium).
            onValueChange={(v) => v && setSize(slot, v as FontSize)}
            className="flex-wrap"
            aria-label={`${title} size`}
          >
            {FONT_SIZES.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id} title={s.hint}>
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Typeface
          </h3>
          <ToggleGroup
            type="single"
            variant="outline"
            value={shelf}
            onValueChange={(v) => v && setShelf(v as FontShelf | 'all')}
            className="flex-wrap"
            aria-label="Filter by kind"
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            {FONT_SHELVES.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id}>
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {inherit && (
          <FaceButton
            face={inherit}
            sample={sample}
            size={size}
            active={active === inherit.key}
            onSelect={() => setFont(slot, inherit.key)}
          />
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          {faces.map((f) => (
            <FaceButton
              key={f.key}
              face={f}
              sample={sample}
              size={size}
              active={active === f.key}
              onSelect={() => setFont(slot, f.key)}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Preview type sizes. Local to the dialog and deliberately not the same
 *  numbers as the CSS multipliers: this is a legibility check at a glance, not
 *  a simulation of the final rendering, and a 0.85 nudge would be invisible in
 *  a card. */
const PREVIEW: Record<FontSize, string> = {
  xsmall: 'text-lg',
  small: 'text-xl',
  medium: 'text-2xl',
  large: 'text-3xl',
};

function FaceButton({
  face,
  sample,
  size,
  active,
  onSelect,
}: {
  face: FontFace;
  sample: string;
  size: FontSize;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-lg border p-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // content-visibility defers rendering (and so the lazy font FETCH) of
        // off-screen cards until they scroll near — without it, opening the
        // dialog pulls the entire library's woff2 at once to paint previews
        // (~5MB, one face alone ~1.9MB). The intrinsic size keeps the
        // scrollbar honest while cards are skipped. A real subsetted-preview
        // pipeline would beat this; until then the fetch at least follows the
        // scroll.
        '[contain-intrinsic-size:auto_5rem] [content-visibility:auto]',
        active ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent/40',
      )}
    >
      <span className="min-w-0 flex-1">
        {/* Clip WIDTH only (overflow-x-clip, bounded by the row) and let the
            glyph HEIGHT overflow (overflow-y-visible) with a taller line box, so
            display faces show their ascenders and descenders instead of being
            shaved — plain `truncate` (overflow:hidden) clipped them. */}
        <span
          className={cn(
            'block overflow-x-clip overflow-y-visible whitespace-nowrap py-1 leading-normal text-foreground',
            PREVIEW[size],
          )}
          style={{ fontFamily: fontFamilyValue(face.key) ?? undefined }}
        >
          {sample}
        </span>
        <span className="mt-1 block truncate text-xs uppercase tracking-wide text-muted-foreground">
          {face.label}
          {face.family ? ` · ${axisCount(face)} axes` : ''}
          {face.italicFile ? ' · true italic' : ''}
        </span>
      </span>
      {active && <Check className="size-4 shrink-0 text-primary-ink" aria-hidden />}
    </button>
  );
}
