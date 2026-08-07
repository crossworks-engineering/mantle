'use client';

import { Ban, Check } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { BACKGROUND_STYLES, requiresAttribution } from '@mantle/web-ui/avatar';
import {
  BACKGROUND_AREAS,
  BACKGROUND_OFF,
  type BackgroundAreaId,
} from '@mantle/web-ui/backgrounds';
import { useBackgrounds } from '@mantle/web-ui/background-provider';
import { GeneratedBackdrop } from '@mantle/web-ui/generated-backdrop';
import { areaPreset, areaSeed } from '@mantle/web-ui/area-backdrop';

/**
 * Which generated background each area of the shell shows.
 *
 * One BLOCK per area, laid out 2x2, because the question a user is actually
 * asking is "what should the menu look like" — not "where could Waves go".
 * Grouping by style instead would make them visit every block to answer it
 * once.
 *
 * Each swatch previews with the area's OWN seed, crop and opacity (see
 * area-backdrop), so a tile is the artwork that area will get, not a
 * representative sample of the style. That is why the same style looks
 * different from row to row — it genuinely will.
 *
 * OFF LEADS EVERY BLOCK. It is the most common answer for three of the four
 * areas, and putting it first makes "none of these" a choice rather than
 * something you achieve by not choosing.
 *
 * Colour comes from the live theme ramp, so the whole gallery repaints when the
 * colour theme or light/dark changes — no swatch can be stale.
 */

/** Big enough to read the composition, small enough that ~17 fit a row. */
const TILE = 'h-14 w-24';

function Tile({
  selected,
  label,
  onSelect,
  children,
}: {
  selected: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={label}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-lg border text-left transition',
        TILE,
        selected
          ? 'border-primary ring-1 ring-primary'
          : 'border-border hover:border-foreground/30 focus-visible:border-foreground/30',
      )}
    >
      {children}
      {selected && (
        <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
          <Check className="size-3" aria-hidden />
        </span>
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function AreaRow({ area, label, hint }: { area: BackgroundAreaId; label: string; hint: string }) {
  const { backgroundFor, setBackground } = useBackgrounds();
  const current = backgroundFor(area);
  const preset = areaPreset(area);
  const seed = areaSeed(area);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {/* Wraps rather than scrolls. A scroller hides most of the catalogue
          behind a gesture — you cannot compare what you cannot see, and the
          options past the fold went unnoticed. Wrapping shows all 17 at once;
          the block heading is what carries "these are the options for the
          menu", so the single-line reading is not what was holding it. */}
      <div className="flex flex-wrap gap-2">
        <Tile
          selected={current === BACKGROUND_OFF}
          label={`${label}: no background`}
          onSelect={() => setBackground(area, BACKGROUND_OFF)}
        >
          <span className="flex size-full items-center justify-center gap-1 bg-sidebar text-xs text-muted-foreground">
            <Ban className="size-3.5" aria-hidden />
            Off
          </span>
        </Tile>

        {BACKGROUND_STYLES.map((s) => (
          <Tile
            key={s.id}
            selected={current === s.id}
            label={`${label}: ${s.label}${requiresAttribution(s) ? ` (${s.creator}, ${s.license})` : ''}`}
            onSelect={() => setBackground(area, s.id)}
          >
            {/* The tile stands in for the real surface: same sidebar fill under
                it, same crop/opacity over it. */}
            <span className="relative flex size-full items-end bg-sidebar">
              <GeneratedBackdrop
                style={s.id}
                seed={seed}
                position={preset.position}
                fade={preset.fade}
                opacity={preset.opacity}
              />
              <span className="relative w-full truncate bg-gradient-to-t from-sidebar to-transparent px-1.5 pb-1 pt-3 text-[10px] leading-none text-muted-foreground">
                {s.label}
              </span>
            </span>
          </Tile>
        ))}
      </div>
    </div>
  );
}

export function BackgroundGallery() {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2
          id="backgrounds-heading"
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Backgrounds
        </h2>
        <p className="text-xs text-muted-foreground">
          A generated backdrop for each area of the app, drawn from the current colour theme. Each
          preview is the artwork that area will actually get. Pick <strong>Off</strong> to leave an
          area plain.
        </p>
      </div>
      {/* Two columns, so the four areas read as a 2x2 block rather than four
          full-width bands:
              menu | header
              chat | activity
          That is BACKGROUND_AREAS' own order flowing through a 2-column grid —
          no explicit placement — so adding a fifth area extends the block
          instead of breaking the arrangement.

          `items-start` keeps each block its own height: without it the grid
          stretches every cell to the tallest row, and a block whose swatches
          wrap onto one fewer line grows a gap under it. */}
      <div className="grid items-start gap-x-6 gap-y-6 lg:grid-cols-2">
        {BACKGROUND_AREAS.map((a) => (
          <AreaRow key={a.id} area={a.id} label={a.label} hint={a.hint} />
        ))}
      </div>
    </section>
  );
}
