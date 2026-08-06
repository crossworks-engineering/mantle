/**
 * Generated avatars — the one generator both tiers use.
 *
 * DiceBear v10 (`@dicebear/core` + one JSON per style from `@dicebear/styles`)
 * is plain data + plain functions: no React, no `useId()`. That is the whole
 * reason it replaced boring-avatars here. The old library's components crash
 * under `react-dom/server` inside a route handler (the route's bundled React
 * and a dynamically-imported `react-dom/server` are two instances, so the hook
 * dispatcher is null), which forced a 300-line hand-port of its geometry just
 * to serve `/api/agents/[id]/avatar`. This module renders identically in a
 * client component and in a route handler, so that port is gone.
 *
 * ONE STYLE, MANY SEEDS. The style is a brain-level appearance choice (see
 * Settings → Appearance); each agent and the owner differ only by seed. A
 * single family reads as one product while still telling every entity apart —
 * six unrelated styles at once just read as noise.
 *
 * COLOUR. The theme tints the BACKGROUND only; the artwork keeps the style's
 * native palette. That split is deliberate: boring-avatars' variants were
 * colour-driven (marble/sunset/ring are pure colour blends), so forcing one
 * 5-colour ramp through them collapsed every seed into the same mush — the
 * "blends in, no distinction" problem. These styles are FORM-driven, so the
 * silhouette carries the identity and the theme is free to own the background.
 *
 * Every shipped style is CC0 (public domain), so nothing here carries an
 * attribution obligation for a public repo. DiceBear still embeds an RDF
 * credit block in each SVG; it is left intact.
 */

import { Avatar, Style } from '@dicebear/core';

import glass from '@dicebear/styles/glass.json';
import identicon from '@dicebear/styles/identicon.json';
import loops from '@dicebear/styles/loops.json';
import rings from '@dicebear/styles/rings.json';
import shapeGrid from '@dicebear/styles/shape-grid.json';
import shapes from '@dicebear/styles/shapes.json';
import squircles from '@dicebear/styles/squircles.json';

/** The offered styles, in picker order. Abstract and form-driven, so one seed
 *  is legible from the next even at 24px on a single background ramp. */
export const AVATAR_STYLES = [
  { id: 'shapes', label: 'Shapes', json: shapes },
  { id: 'identicon', label: 'Identicon', json: identicon },
  { id: 'loops', label: 'Loops', json: loops },
  { id: 'rings', label: 'Rings', json: rings },
  { id: 'squircles', label: 'Squircles', json: squircles },
  { id: 'shape-grid', label: 'Shape grid', json: shapeGrid },
  { id: 'glass', label: 'Glass', json: glass },
] as const;

export type AvatarStyleId = (typeof AVATAR_STYLES)[number]['id'];

export const DEFAULT_AVATAR_STYLE: AvatarStyleId = 'shapes';

export const AVATAR_STYLE_IDS: readonly string[] = AVATAR_STYLES.map((s) => s.id);

/** boring-avatars variant → nearest shipped style. Stored avatars carry the old
 *  ids, so they are translated on READ rather than migrated: nobody's avatar
 *  vanishes, and re-saving is not required to get a valid one. */
const LEGACY_STYLES: Record<string, AvatarStyleId> = {
  beam: 'shapes',
  bauhaus: 'shapes',
  geometric: 'shapes', // deprecated boring-avatars alias
  abstract: 'shapes', // deprecated boring-avatars alias
  marble: 'glass',
  sunset: 'glass',
  pixel: 'identicon',
  ring: 'rings',
};

/** Resolve any stored style id — current, legacy, empty or unknown — to a
 *  style that exists. Never throws; unknown ids fall back to the default. */
export function resolveAvatarStyle(id: string | null | undefined): AvatarStyleId {
  if (!id) return DEFAULT_AVATAR_STYLE;
  if (AVATAR_STYLE_IDS.includes(id)) return id as AvatarStyleId;
  return LEGACY_STYLES[id] ?? DEFAULT_AVATAR_STYLE;
}

// `Style` parses and validates the JSON once; building one per render would
// re-do that on every avatar in a list. Cached by id, keyed off the same
// registry so a new style is picked up by adding a row above and nothing else.
const STYLES = new Map<string, Style>();
function styleFor(id: AvatarStyleId): Style {
  let s = STYLES.get(id);
  if (!s) {
    const entry = AVATAR_STYLES.find((e) => e.id === id) ?? AVATAR_STYLES[0];
    s = new Style(entry.json as ConstructorParameters<typeof Style>[0]);
    STYLES.set(id, s);
  }
  return s;
}

/** DiceBear validates colours as hex and REJECTS anything else (it throws on
 *  `oklch(...)`). Every token in themes.css is authored/emitted as hex, so the
 *  theme ramp passes straight through — but a caller reading a live CSS custom
 *  property is one theme edit away from handing us something else, and an
 *  avatar must never be the thing that throws. Drop what wouldn't validate. */
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function hexOnly(colors: readonly string[] | undefined): string[] | undefined {
  if (!colors?.length) return undefined;
  const ok = colors.map((c) => c.trim()).filter((c) => HEX.test(c));
  return ok.length ? ok : undefined;
}

export type RenderAvatarOptions = {
  /** Stored style id; legacy and unknown ids are resolved, not rejected. */
  style?: string | null;
  /** Stable per-entity seed — the same seed always yields the same avatar. */
  seed: string;
  /** Rendered px. Sets the root svg width/height; the viewBox scales. */
  size?: number;
  /** Theme ramp (hex) for the BACKGROUND. `backgroundColor` is a core option,
   *  so it applies even to styles that declare no background colour group
   *  (rings, identicon). Omit to keep the style's native background. */
  background?: readonly string[];
};

/** Render an avatar to an SVG string. Pure and deterministic — same inputs,
 *  same bytes — in the browser and on the server alike. */
export function renderAvatarSvg({
  style,
  seed,
  size = 40,
  background,
}: RenderAvatarOptions): string {
  const backgroundColor = hexOnly(background);
  return new Avatar(styleFor(resolveAvatarStyle(style)), {
    seed: seed || 'mantle',
    size,
    ...(backgroundColor ? { backgroundColor } : {}),
  }).toString();
}

/** A short, stable seed for a brand-new avatar. */
export function randomAvatarSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}
