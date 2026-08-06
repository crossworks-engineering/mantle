'use client';

import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { Input } from '@mantle/web-ui/ui/input';
import { RadioGroup, RadioGroupCard } from '@mantle/web-ui/ui/radio-group';
import {
  AVATAR_PICKER_STYLES,
  AVATAR_TINTS,
  avatarStyleMeta,
  requiresAttribution,
  type AvatarStyleMeta,
} from '@mantle/web-ui/avatar';
import { useAvatarStyle } from '@mantle/web-ui/avatar-style-provider';
import { GeneratedAvatar } from '@mantle/web-ui/generated-avatar';

/**
 * The brain's avatar style — one visual language for every generated avatar
 * (see @mantle/web-ui/avatar). One style, one seed per entity.
 *
 * Each card previews the SAME four seeds, because the thing worth comparing is
 * not how pretty a style is on its own but how far apart it pushes two
 * different entities — that is the whole job of an avatar.
 *
 * Split in two, because the two halves want different widths. The CONTROLS
 * (what the setting is, and the tint) sit in the Appearance grid's interface
 * column beside the other interface settings; the LIST is a browsing surface for
 * 50 styles and takes a full-width row of its own beneath the grid.
 *
 * They share no local state — the filter belongs to the list, and the selection
 * lives in the provider — so the split costs nothing to keep in step.
 *
 * Creator and licence sit on the card rather than in a footnote: 14 of these
 * are CC BY 4.0, which requires attribution, and the honest place to say whose
 * work you are about to adopt is where you choose it. docs/avatar-styles.md
 * carries the full credit list.
 */

/** Fixed, unrelated strings so the grid looks the same on every brain. */
const PREVIEW_SEEDS = ['aurora', 'basalt', 'cinder', 'dovetail'];

/** Fold to letters+digits so "pixel art", "Pixel Art" and "pixel-art" match. */
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The avatar SETTING: what it is, and how much theme it takes on. Lives in the
 * interface column; the styles themselves are browsed in AvatarStyleList below.
 * Tint sits with the controls rather than over the list because it restyles
 * every swatch, and previews follow it live.
 */
export function AvatarStyleControls() {
  const { avatarTint, setAvatarTint } = useAvatarStyle();
  return (
    <section className="space-y-2">
      <h2
        id="avatar-style-heading"
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        Avatar style
      </h2>
      <p className="text-xs text-muted-foreground">
        Every generated avatar in this brain — yours and each agent&rsquo;s — is drawn in one style;
        the seed is what makes each one different. Pick the style below.
      </p>
      <RadioGroup
        value={avatarTint}
        onValueChange={(v) => setAvatarTint(v as (typeof AVATAR_TINTS)[number]['id'])}
        aria-label="Avatar colour"
        className="gap-2"
      >
        {AVATAR_TINTS.map((t) => (
          <RadioGroupCard
            key={t.id}
            value={t.id}
            className={cn(
              'flex flex-col items-start gap-0.5 border-border p-2 text-left',
              'hover:bg-accent/40',
              'data-[state=checked]:border-primary data-[state=checked]:bg-accent/50 data-[state=checked]:ring-1 data-[state=checked]:ring-primary',
            )}
          >
            <span className="text-sm font-medium text-foreground">{t.label}</span>
            <span className="text-xs leading-snug text-muted-foreground">{t.hint}</span>
          </RadioGroupCard>
        ))}
      </RadioGroup>
    </section>
  );
}

function StyleCard({ style, active }: { style: AvatarStyleMeta; active: boolean }) {
  return (
    <RadioGroupCard
      value={style.id}
      className={cn(
        'flex flex-col items-start gap-2 border-border p-3 text-left',
        'hover:bg-accent/40',
        'data-[state=checked]:border-primary data-[state=checked]:ring-1 data-[state=checked]:ring-primary',
      )}
    >
      <span className="flex w-full items-start justify-between gap-2">
        <span className="flex gap-1.5" aria-hidden>
          {PREVIEW_SEEDS.map((seed) => (
            <GeneratedAvatar key={seed} style={style.id} seed={seed} size={38} />
          ))}
        </span>
        {active && <Check className="size-4 shrink-0 text-primary-ink" aria-hidden />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{style.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {style.creator}
          {requiresAttribution(style) ? ` · ${style.license}` : ''}
        </span>
      </span>
    </RadioGroupCard>
  );
}

/**
 * Browsing surface for the 50 styles: filter, then a card per style grouped by
 * shelf. Full-width by design — it is the one thing on this screen that genuinely
 * needs the room, and the cards each carry four live previews.
 */
export function AvatarStyleList() {
  const { avatarStyle, setAvatarStyle } = useAvatarStyle();
  const [query, setQuery] = useState('');
  const needle = fold(query);

  /**
   * The offered list is the `avatars` category only — the background styles
   * moved to their own gallery below.
   *
   * A brain that chose one BEFORE the split (the old default, `shapes`, was one
   * of them) keeps rendering it, so its current style is prepended rather than
   * dropped: a picker that shows nothing selected reads as broken, and the only
   * way back would be to pick something else.
   */
  const offered = useMemo(() => {
    const current = avatarStyleMeta(avatarStyle);
    return AVATAR_PICKER_STYLES.some((s) => s.id === current.id)
      ? AVATAR_PICKER_STYLES
      : [current, ...AVATAR_PICKER_STYLES];
  }, [avatarStyle]);

  const matches = useMemo(
    () =>
      needle
        ? offered.filter(
            (s) =>
              fold(s.label).includes(needle) ||
              fold(s.id).includes(needle) ||
              fold(s.creator).includes(needle),
          )
        : offered,
    [needle, offered],
  );

  return (
    <section className="space-y-3">
      {/* The count belongs with the filter that changes it, not up with the
          setting's heading — which lives in the other column entirely. */}
      <div className="flex items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter styles"
            aria-label="Filter avatar styles"
            className="h-8 rounded-lg pl-8 pr-2"
          />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {needle ? `${matches.length} of ${offered.length}` : offered.length}
        </span>
      </div>

      {matches.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">
          No style matches &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : (
        <RadioGroup
          value={avatarStyle}
          onValueChange={setAvatarStyle}
          aria-labelledby="avatar-style-heading"
          className="gap-5"
        >
          {/* One flat grid — since the split there is only one category here,
              and a lone "Avatars" heading over the whole list says nothing the
              section heading has not already said. */}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {matches.map((s) => (
              <StyleCard key={s.id} style={s} active={avatarStyle === s.id} />
            ))}
          </div>
        </RadioGroup>
      )}
    </section>
  );
}
