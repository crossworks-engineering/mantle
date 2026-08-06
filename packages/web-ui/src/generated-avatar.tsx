'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { cn } from './lib/utils';
import { useColorTheme } from './color-theme-provider';
import { useAvatarStyle } from './avatar-style-provider';
import {
  isAvatarStyleReady,
  loadAvatarStyle,
  renderAvatarSvgSync,
  type AvatarTint,
} from './avatar';

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
 *
 * The style's JSON is fetched on demand (see avatar.ts — 50 styles are 2.47 MB,
 * far too much to put in every page's bundle for one 32px circle), so the first
 * render of a not-yet-loaded style draws an empty circle of the right size and
 * swaps in the artwork when the chunk lands. Reserving the box rather than
 * rendering nothing keeps avatars from shifting the layout as they arrive. In
 * practice this costs one fetch per session: the whole app draws ONE style.
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
  tint: tintOverride,
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
  /** Override the brain's tint — previews only, same rule as `style`. */
  tint?: AvatarTint;
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
  const { avatarStyle, avatarTint } = useAvatarStyle();
  const effectiveStyle = style ?? avatarStyle;
  const tint = tintOverride ?? avatarTint;
  // Both inputs land on <html> as a class/attribute, so re-read whenever either
  // changes. Server render and first paint use the fallback; the effect swaps in
  // the real ramp once the document is readable.
  const [ramp, setRamp] = React.useState<string[]>(FALLBACK_RAMP);
  React.useEffect(() => {
    setRamp(readChartRamp(`${colorTheme}:${resolvedTheme}`));
  }, [colorTheme, resolvedTheme]);

  // Re-render once the style's chunk arrives. `ready` starts true when the
  // style is already cached (the common case after the first avatar), so a
  // populated list paints in one pass rather than flashing empty circles.
  const [ready, setReady] = React.useState(() => isAvatarStyleReady(effectiveStyle));
  React.useEffect(() => {
    if (isAvatarStyleReady(effectiveStyle)) {
      setReady(true);
      return;
    }
    let live = true;
    setReady(false);
    loadAvatarStyle(effectiveStyle).then(
      () => live && setReady(true),
      // Chunk failed to load — leave the placeholder rather than throwing an
      // avatar through an error boundary and taking the screen with it.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [effectiveStyle]);

  // EVERY input the render reads must be in here. Miss one and the avatar keeps
  // handing back the previously-drawn SVG while the rest of the app has already
  // moved on — the picker looks dead because the memo, not the state, is stale.
  const svg = React.useMemo(
    () => (ready ? renderAvatarSvgSync({ style: effectiveStyle, seed, size, ramp, tint }) : null),
    [ready, effectiveStyle, tint, seed, size, ramp],
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
      {...(svg ? { dangerouslySetInnerHTML: { __html: svg } } : {})}
    />
  );
}
