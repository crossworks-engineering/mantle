/**
 * Generated BACKDROPS — the same DiceBear styles the avatars use, drawn as a
 * full-bleed surface instead of a 40px circle.
 *
 * EXPERIMENTAL. The observation behind it: several of the Minimalist and Scenes
 * styles (waves, landscape, constellation, stripes, weave) are not really
 * portraits at all — they are small abstract compositions that read far better
 * at panel size than at avatar size. This module renders one to fill a region.
 *
 * It deliberately reuses `avatar.ts` rather than forking it: the same registry,
 * the same lazy per-style chunk, the same parsed-`Style` cache. A brain that
 * already draws `waves` avatars pays nothing extra to also draw a `waves`
 * backdrop, and the two can never disagree about what `waves` means.
 *
 * TWO THINGS DIFFER from an avatar, and both are the whole job:
 *
 * 1. FIT. DiceBear hard-codes `width`/`height` on the root `<svg>` and omits
 *    `preserveAspectRatio`, so the default (`xMidYMid meet`) letterboxes a
 *    square composition inside a tall sidebar. `fitSvg` rewrites the root tag to
 *    scale-and-crop instead, which is what "background" means.
 *
 * 2. UPRIGHT. Most of these styles randomise rotation per seed — `waves`
 *    picks from a full 360°, so one seed in two hangs the sea from the ceiling.
 *    Charming on a 32px circle, wrong on a wall. Where a style offers a `none`
 *    rotation variant we ask for it; where it doesn't, the seed still decides.
 */

import { Avatar } from '@dicebear/core';
import { loadAvatarStyle, loadedAvatarStyle, resolveAvatarStyle, type Loaded } from './avatar';

/** Waves is the default because its layered bands degrade the most gracefully
 *  under a heavy crop — at panel scale you see two or three sweeping edges
 *  rather than a busy field competing with the nav labels on top of it. */
export const DEFAULT_BACKDROP_STYLE = 'waves';

/**
 * Styles that earn their keep at panel size.
 *
 * Not a hard restriction — `renderBackdropSvg` will draw any style in the
 * avatar registry — but a character style stretched across a sidebar is a giant
 * face, not a background, so these are what a picker should offer.
 */
export const BACKDROP_STYLE_IDS: readonly string[] = [
  'waves',
  'landscape',
  'constellation',
  'stripes',
  'weave',
  'shape-grid',
  'glass',
  'blobs',
];

/**
 * Rewrite the root `<svg>` so it fills its box instead of sizing itself.
 *
 * Only the FIRST tag is touched, and only its sizing attributes — the
 * `<metadata>` RDF credit block DiceBear embeds (which the CC BY styles' licence
 * relies on) and every drawn element are left exactly as generated.
 *
 * `slice` scales the viewBox to COVER the box and crops the overflow, the SVG
 * equivalent of `background-size: cover`.
 */
export function fitSvg(svg: string, position = 'xMidYMid'): string {
  return svg.replace(/^<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\s(?:width|height)="[^"]*"/g, '')
      .replace(/\spreserveAspectRatio="[^"]*"/g, '')
      .replace(/^<svg/, `<svg preserveAspectRatio="${position} slice"`),
  );
}

export type RenderBackdropOptions = {
  /** Style id from the avatar registry. Unknown ids resolve, never throw. */
  style?: string | null;
  /** Stable seed — the same seed always yields the same backdrop. */
  seed: string;
  /** The theme's chart ramp, as hex. Omit to keep the style's own palette. */
  ramp?: readonly string[];
  /** Where the crop is anchored, as an SVG `preserveAspectRatio` alignment.
   *  `xMidYMax` keeps the bottom edge — which is where wave crests live. */
  position?: string;
  /** Let the style pick its own rotation, as it does for avatars. Off by
   *  default: see the UPRIGHT note above. */
  allowRotation?: boolean;
};

/** DiceBear rejects any colour that isn't hex (it throws on `oklch(...)`).
 *  Mirrors avatar.ts — a backdrop must never be the thing that takes a screen
 *  down, so anything that wouldn't validate is dropped rather than passed. */
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function hexOnly(colors: readonly string[] | undefined): string[] | undefined {
  if (!colors?.length) return undefined;
  const ok = colors.map((c) => c.trim()).filter((c) => HEX.test(c));
  return ok.length ? ok : undefined;
}

function draw(loaded: Loaded, opts: RenderBackdropOptions): string {
  const { seed, ramp, position, allowRotation } = opts;
  // 100 matches these styles' native viewBox, so nothing is scaled twice; the
  // attribute is stripped by fitSvg anyway and only the viewBox survives.
  const dicebear: Record<string, unknown> = { seed: seed || 'mantle', size: 100 };

  const colors = hexOnly(ramp);
  if (colors) {
    dicebear.backgroundColor = colors;
    // Groups declared `contrastTo` another group are left alone deliberately —
    // DiceBear solves them to black or white against whatever background it
    // picked. For `waves` that IS the wave colour, so honouring it is what
    // keeps the crests legible on every theme rather than tinting them into
    // the background. Same rule as the avatar's `theme` tint.
    for (const g of loaded.tintGroups) dicebear[`${g}Color`] = colors;
  }

  // Only ask for a variant the style actually declares — DiceBear throws on an
  // unknown option key, and not every style has a `rotation` component.
  if (!allowRotation && loaded.variants.rotation?.includes('none')) {
    dicebear.rotationVariant = ['none'];
  }
  // Several of these styles ship CSS-keyframe drift variants. A nav that moves
  // forever is a distraction, so pin the still one where it exists.
  if (loaded.variants.animation?.includes('none')) {
    dicebear.animationVariant = ['none'];
  }

  return fitSvg(new Avatar(loaded.style, dicebear).toString(), position);
}

/** Render synchronously, or null if the style's chunk has not been fetched yet.
 *  Shaped for React, which cannot await inside a render. */
export function renderBackdropSvgSync(opts: RenderBackdropOptions): string | null {
  const loaded = loadedAvatarStyle(resolveAvatarStyle(opts.style ?? DEFAULT_BACKDROP_STYLE));
  return loaded ? draw(loaded, opts) : null;
}

/** Render, fetching the style's JSON first if needed. */
export async function renderBackdropSvg(opts: RenderBackdropOptions): Promise<string> {
  const loaded = await loadAvatarStyle(opts.style ?? DEFAULT_BACKDROP_STYLE);
  return draw(loaded, opts);
}
