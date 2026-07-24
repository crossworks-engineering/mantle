'use client';

import { useEffect, useState } from 'react';
import Avatar from 'boring-avatars';
import { useTheme } from 'next-themes';
import { cn } from '@mantle/web-ui/lib/utils';
import { AVATAR_STYLE_IDS, DEFAULT_AVATAR_STYLE, type AvatarStyleId } from '@/lib/avatar';
import { useColorTheme } from '@/components/color-theme-provider';

/**
 * Renders a boring-avatars SVG for a {variant, seed}. boring-avatars is tiny,
 * so we render it directly client-side (no server endpoint). The wrapper clips
 * to a circle so square variants (pixel/bauhaus) match the rest.
 *
 * Colours are theme-aware: we read the active theme's --chart-1..5 tokens and
 * feed them to boring-avatars, re-reading whenever the mode (light/dark) or
 * color theme changes. (SVG `fill` attributes can't resolve `var()`, so we
 * pass the resolved values.) Falls back to the clean-slate chart palette
 * before mount, so the default theme shows no flash.
 */

const VARIANTS = new Set<string>(AVATAR_STYLE_IDS);

/** Clean-slate (default theme) --chart-1..5, used until we can read the live
 *  tokens on the client — keeps the default theme flash-free. */
const FALLBACK_PALETTE = [
  'oklch(0.5854 0.2041 277.1173)',
  'oklch(0.5106 0.2301 276.9656)',
  'oklch(0.4568 0.2146 277.0229)',
  'oklch(0.3984 0.1773 277.3662)',
  'oklch(0.3588 0.1354 278.6973)',
];

function readChartColors(): string[] {
  if (typeof document === 'undefined') return FALLBACK_PALETTE;
  const cs = getComputedStyle(document.documentElement);
  const vals = [1, 2, 3, 4, 5]
    .map((i) => cs.getPropertyValue(`--chart-${i}`).trim())
    .filter((v) => v.length > 0);
  return vals.length >= 2 ? vals : FALLBACK_PALETTE;
}

export function BoringAvatar({
  variant,
  seed,
  size = 40,
  className,
  style,
}: {
  /** boring-avatars variant id (the stored avatar "style"). */
  variant: string;
  seed: string;
  /** Pixel size — the single source of truth for the avatar's box. */
  size?: number;
  /** Decoration only (ring, border, margin). Don't size with this. */
  className?: string;
  style?: React.CSSProperties;
}) {
  const v = (VARIANTS.has(variant) ? variant : DEFAULT_AVATAR_STYLE) as AvatarStyleId;
  const { resolvedTheme } = useTheme();
  const { colorTheme } = useColorTheme();
  const [colors, setColors] = useState<string[]>(FALLBACK_PALETTE);

  // Re-read the theme's chart palette on mount and whenever the mode or color
  // theme changes (both swap the resolved --chart-* values).
  useEffect(() => {
    setColors(readChartColors());
  }, [resolvedTheme, colorTheme]);

  return (
    <span
      className={cn(
        'inline-flex shrink-0 overflow-hidden rounded-full',
        // Force the inner <svg> to fill the wrapper, overriding any ancestor
        // svg-sizing rule (e.g. Button's [&_svg]:size-4) that would otherwise
        // shrink the avatar.
        '[&>svg]:!size-full',
        className,
      )}
      style={{ width: size, height: size, ...style }}
      aria-hidden
    >
      <Avatar name={seed || 'mantle'} variant={v} size={size} colors={colors} />
    </span>
  );
}
