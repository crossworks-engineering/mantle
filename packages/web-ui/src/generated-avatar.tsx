'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { cn } from './lib/utils';
import { useColorTheme } from './color-theme-provider';
import { useAvatarStyle } from './avatar-style-provider';
import { renderAvatarSvg } from './avatar';

/**
 * The generated avatar, themed to the live palette.
 *
 * The theme tints the BACKGROUND only — the artwork keeps its style's native
 * colours. See avatar.ts for why that split is what makes seeds tell apart.
 *
 * Colours come from the active theme's `--chart-1..5`, read off the document
 * rather than imported: those tokens change with BOTH the mode and the colour
 * theme, and SVG fill attributes can't resolve `var()`, so the resolved values
 * have to be passed in. themes.css emits every token as hex, which is exactly
 * what DiceBear accepts.
 */

/** Clean Slate (the default theme) `--chart-1..5`, light mode — used for the
 *  first paint before the live tokens can be read, so the default theme never
 *  flashes. Values are GENERATED (themes/seeds.mjs → `pnpm themes:build`); if
 *  the ramp recipe changes, refresh them from `:root` in themes.css. */
const FALLBACK_RAMP = ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'];

// A list of 40 agents would otherwise run 40 identical getComputedStyle reads
// on mount. The ramp only depends on (colour theme, mode), so cache on that.
const rampCache = new Map<string, string[]>();

function readChartRamp(key: string): string[] {
  const hit = rampCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return FALLBACK_RAMP;
  const cs = getComputedStyle(document.documentElement);
  const vals = [1, 2, 3, 4, 5]
    .map((i) => cs.getPropertyValue(`--chart-${i}`).trim())
    .filter((v) => v.length > 0);
  const ramp = vals.length >= 2 ? vals : FALLBACK_RAMP;
  rampCache.set(key, ramp);
  return ramp;
}

export function GeneratedAvatar({
  style,
  seed,
  size = 40,
  className,
  containerStyle,
}: {
  /** Override the brain's style — for previews (the Appearance picker) only.
   *  Everywhere else, leave it unset: the style is a brain-level choice, and a
   *  per-entity style is exactly the jumble this replaced. Legacy
   *  boring-avatars ids still resolve. */
  style?: string | null;
  /** Stable per-entity value — agent slug, user id, or a stored random seed.
   *  This is what makes one avatar differ from the next. */
  seed: string;
  /** Pixel size — the single source of truth for the avatar's box. */
  size?: number;
  /** Decoration only (ring, border, margin). Don't size with this. */
  className?: string;
  containerStyle?: React.CSSProperties;
}) {
  const { resolvedTheme } = useTheme();
  const { colorTheme } = useColorTheme();
  const { avatarStyle } = useAvatarStyle();
  const effectiveStyle = style ?? avatarStyle;
  // Both inputs land on <html> as a class/attribute, so re-read whenever either
  // changes. Server render and first paint use the fallback; the effect swaps in
  // the real ramp once the document is readable.
  const [ramp, setRamp] = React.useState<string[]>(FALLBACK_RAMP);
  React.useEffect(() => {
    setRamp(readChartRamp(`${colorTheme}:${resolvedTheme}`));
  }, [colorTheme, resolvedTheme]);

  const svg = React.useMemo(
    () => renderAvatarSvg({ style: effectiveStyle, seed, size, background: ramp }),
    [effectiveStyle, seed, size, ramp],
  );

  return (
    <span
      className={cn(
        'inline-flex shrink-0 overflow-hidden rounded-full',
        // Force the inner <svg> to fill the wrapper, overriding any ancestor
        // svg-sizing rule (e.g. Button's [&_svg]:size-4) that would shrink it.
        '[&>svg]:!size-full',
        className,
      )}
      style={{ width: size, height: size, ...containerStyle }}
      aria-hidden
      // Generated from a seed by DiceBear — not user-supplied markup.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
