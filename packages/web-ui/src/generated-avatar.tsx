'use client';

import * as React from 'react';
import { cn } from './lib/utils';
import { useAvatarStyle } from './avatar-style-provider';
import { useChartRamp } from './theme-ramp';
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
 * Colours come from the active theme's `--chart-1..5` via `useChartRamp`, see
 * theme-ramp.ts for why they are read off the document rather than imported.
 * That hook is shared with the generated backdrop so the two can never end up
 * on different palettes.
 *
 * The style's JSON is fetched on demand (see avatar.ts — 50 styles are 2.47 MB,
 * far too much to put in every page's bundle for one 32px circle), so the first
 * render of a not-yet-loaded style draws an empty circle of the right size and
 * swaps in the artwork when the chunk lands. Reserving the box rather than
 * rendering nothing keeps avatars from shifting the layout as they arrive. In
 * practice this costs one fetch per session: the whole app draws ONE style.
 */

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
  const { avatarStyle, avatarTint } = useAvatarStyle();
  const effectiveStyle = style ?? avatarStyle;
  const tint = tintOverride ?? avatarTint;
  const ramp = useChartRamp();

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
