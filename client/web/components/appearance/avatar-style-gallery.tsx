'use client';

import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { Input } from '@mantle/web-ui/ui/input';
import { RadioGroup, RadioGroupCard } from '@mantle/web-ui/ui/radio-group';
import {
  AVATAR_CATEGORIES,
  AVATAR_STYLES,
  AVATAR_TINTS,
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
 * Tint sits above the list rather than beside the style, because it changes
 * every swatch below it and you need to see them move.
 *
 * Everything here is a SINGLE column: this panel lives in one third of the
 * Appearance grid, and Tailwind's breakpoints are viewport-based, not
 * container-based — an `xl:grid-cols-3` inside a narrow column would happily
 * split it into three unreadable slivers on a wide screen.
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

/** Tint — how much of the theme the avatars take on. Sits above the grid
 *  because it changes every swatch below it, so it has to be visible while you
 *  compare them. Previews follow it live. */
function TintControl() {
  const { avatarTint, setAvatarTint } = useAvatarStyle();
  return (
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
            'flex flex-col items-start gap-1 border-border p-2.5 text-left',
            'hover:bg-accent/40',
            'data-[state=checked]:border-primary data-[state=checked]:bg-accent/50 data-[state=checked]:ring-1 data-[state=checked]:ring-primary',
          )}
        >
          <span className="text-sm font-medium text-foreground">{t.label}</span>
          <span className="text-xs leading-snug text-muted-foreground">{t.hint}</span>
        </RadioGroupCard>
      ))}
    </RadioGroup>
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

export function AvatarStyleGallery() {
  const { avatarStyle, setAvatarStyle } = useAvatarStyle();
  const [query, setQuery] = useState('');
  const needle = fold(query);

  const matches = useMemo(
    () =>
      needle
        ? AVATAR_STYLES.filter(
            (s) =>
              fold(s.label).includes(needle) ||
              fold(s.id).includes(needle) ||
              fold(s.creator).includes(needle),
          )
        : AVATAR_STYLES,
    [needle],
  );

  return (
    <section className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h2
            id="avatar-style-heading"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Avatar style
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {needle ? `${matches.length} of ${AVATAR_STYLES.length}` : AVATAR_STYLES.length}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Every generated avatar in this brain — yours and each agent&rsquo;s — is drawn in this
          style; the seed is what makes each one different.
        </p>
      </div>

      <TintControl />

      <div className="relative">
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
          {AVATAR_CATEGORIES.map((cat) => {
            const inCat = matches.filter((s) => s.category === cat.id);
            if (inCat.length === 0) return null;
            return (
              <div key={cat.id} className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">{cat.label}</h3>
                <div className="grid gap-2">
                  {inCat.map((s) => (
                    <StyleCard key={s.id} style={s} active={avatarStyle === s.id} />
                  ))}
                </div>
              </div>
            );
          })}
        </RadioGroup>
      )}
    </section>
  );
}
