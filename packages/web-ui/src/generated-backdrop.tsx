'use client';

import * as React from 'react';
import { cn } from './lib/utils';
import { useChartRamp } from './theme-ramp';
import { isAvatarStyleReady, loadAvatarStyle } from './avatar';
import {
  DEFAULT_BACKDROP_STYLE,
  renderBackdropSvgSync,
  type RenderBackdropOptions,
} from './backdrop';

/**
 * A generated backdrop, themed to the live palette. EXPERIMENTAL.
 *
 * Draws a DiceBear style as a decorative surface behind a panel's content — see
 * backdrop.ts for why that is more than just a bigger avatar.
 *
 * THE HARD PART IS NOT DRAWING IT, IT IS STAYING READABLE. This is a background
 * behind navigation text, so every default here is chosen to keep the text
 * winning:
 *
 * - `opacity` is low by default. The ramp colours are chart colours — chosen to
 *   be distinguishable against each other, which makes them loud. At full
 *   strength one of them behind a menu label is a contrast failure, so the
 *   artwork is a tint, not a slab.
 * - `fade` masks the layer to nothing over the top of the panel, which is
 *   exactly where the nav items are densest. The composition survives at the
 *   bottom, where the panel is usually empty.
 * - Nothing here is interactive: `pointer-events-none` and `aria-hidden`, so it
 *   can never eat a click meant for a nav item or add noise to a screen reader.
 *
 * It renders nothing at all until the style's JSON chunk arrives — unlike an
 * avatar there is no box to reserve, so there is nothing to shift.
 */
export function GeneratedBackdrop({
  style = DEFAULT_BACKDROP_STYLE,
  seed,
  position,
  allowRotation,
  opacity = 0.2,
  fade = 'to-top',
  themed = true,
  className,
}: {
  /** Style id from the avatar registry. */
  style?: string | null;
  /** Stable seed — same seed, same backdrop. */
  seed: string;
  /** Crop anchor, as an SVG `preserveAspectRatio` alignment. */
  position?: RenderBackdropOptions['position'];
  allowRotation?: boolean;
  /** 0–1. Keep it low behind text. */
  opacity?: number;
  /** Which way the artwork fades out. `none` keeps it at full strength — only
   *  safe on a panel with no text over it. */
  fade?: 'to-top' | 'to-bottom' | 'none';
  /** Theme the artwork from `--chart-1..5`. Off keeps the style's own palette. */
  themed?: boolean;
  className?: string;
}) {
  const ramp = useChartRamp();

  // Re-render once the chunk arrives. Starts true when the style is already
  // cached — the common case, since the avatars have usually loaded it already.
  const [ready, setReady] = React.useState(() => isAvatarStyleReady(style));
  React.useEffect(() => {
    if (isAvatarStyleReady(style)) {
      setReady(true);
      return;
    }
    let live = true;
    setReady(false);
    loadAvatarStyle(style).then(
      () => live && setReady(true),
      // Chunk failed — draw nothing. A decorative layer must never throw a
      // whole panel through an error boundary.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [style]);

  // Every input the render reads must be listed, or the layer keeps handing
  // back previously-drawn markup after the theme has already moved on.
  const svg = React.useMemo(
    () =>
      ready
        ? renderBackdropSvgSync({
            style,
            seed,
            position,
            allowRotation,
            ramp: themed ? ramp : undefined,
          })
        : null,
    [ready, style, seed, position, allowRotation, themed, ramp],
  );

  if (!svg) return null;

  // Masked in both the standard and the -webkit- property: Safari still needs
  // the prefix, and an unrecognised mask silently shows the layer at FULL
  // strength over the text rather than failing visibly.
  const mask =
    fade === 'none'
      ? undefined
      : fade === 'to-top'
        ? 'linear-gradient(to top, #000 0%, rgba(0,0,0,0.55) 45%, transparent 85%)'
        : 'linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.55) 45%, transparent 85%)';

  return (
    <span
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden',
        '[&>svg]:!h-full [&>svg]:!w-full',
        className,
      )}
      style={{
        opacity,
        ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : {}),
      }}
      aria-hidden
      // Generated from a seed by DiceBear — not user-supplied markup.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
