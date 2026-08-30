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
 * COLOUR is a setting — see `AvatarTint`. The default, `mixed`, tints only the
 * BACKGROUND and leaves the artwork its native palette; `native` themes
 * nothing and `theme` repaints every colour group a style exposes. Why `mixed`
 * is the default: boring-avatars' variants were colour-driven (marble, sunset
 * and ring are pure colour blends), so forcing one 5-colour ramp through them
 * collapsed every seed into the same mush — the "blends in, no distinction"
 * problem this replaced. Tinting the background alone keeps a brain on-theme
 * while the artwork goes on carrying the identity.
 *
 * WHY THE JSON IS LAZY. All 50 styles are 2.47 MB of JSON, and an avatar
 * renders in the app shell on EVERY screen — statically importing the set
 * would put all of it in the first load of every page to draw one 32px circle.
 * So each style is a `() => import()` and lands in its own chunk: the app
 * fetches the ONE style the brain uses, once, and the picker (a single
 * settings screen) is the only place that pulls more. The arrow functions are
 * written out per style rather than built from a template literal so both
 * bundlers can see every target statically.
 *
 * LICENCES. Not all styles are CC0 — 14 are CC BY 4.0, which REQUIRES
 * attribution. Every style therefore carries its creator and licence here,
 * the picker shows them at the point of choice, and docs/avatar-styles.md is
 * the human-readable credit list. DiceBear also embeds an RDF credit block in
 * each SVG, which is left intact. `avatar.test.ts` checks this table against
 * the installed package so a version bump cannot silently restate a licence.
 */

import { Avatar, Style } from '@dicebear/core';

/**
 * What a style is FOR.
 *
 * The catalogue used to be split by look (minimalist / characters / scenes),
 * which described the artwork but not the job. Since the same generator now
 * draws both 32px avatars and full-panel backgrounds (see backdrop.ts), the
 * useful split is by PURPOSE; a portrait makes a poor wallpaper, and a field
 * of waves makes an unrecognisable avatar.
 *
 * `initials`, `initial-face`, `glyphs` and `icons` sit under `avatars` despite
 * being minimal: they encode an identity, which is an avatar's whole job and
 * meaningless spread across a sidebar.
 */
export type AvatarStyleCategory = 'avatars' | 'backgrounds';

export type AvatarStyleMeta = {
  id: string;
  label: string;
  category: AvatarStyleCategory;
  /** Designer, for attribution. Mirrors the style JSON's `meta.creator.name`. */
  creator: string;
  /** SPDX-ish licence name. Mirrors the style JSON's `meta.license.name`. */
  license: string;
  /** Dynamic import of the style's JSON — one chunk per style. */
  load: () => Promise<unknown>;
};

/** Human-readable category names, in picker order. */
export const AVATAR_CATEGORIES: Array<{ id: AvatarStyleCategory; label: string }> = [
  { id: 'avatars', label: 'Avatars' },
  { id: 'backgrounds', label: 'Backgrounds' },
];

/** Licences that impose no attribution duty. Anything else is credited in the
 *  picker and in docs/avatar-styles.md. */
const NO_ATTRIBUTION_REQUIRED = new Set(['CC0 1.0', 'MIT']);

/** Whether picking this style obliges us to credit its designer. */
export function requiresAttribution(style: AvatarStyleMeta): boolean {
  return !NO_ATTRIBUTION_REQUIRED.has(style.license);
}

export const AVATAR_STYLES: AvatarStyleMeta[] = [
  // ── avatars ─────────────────────────────────────────────────────
  {
    id: 'glyphs',
    label: 'Glyphs',
    category: 'avatars',
    creator: 'Matt Houser',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/glyphs.json'),
  },
  {
    id: 'icons',
    label: 'Icons',
    category: 'avatars',
    creator: 'The Bootstrap Authors',
    license: 'MIT',
    load: () => import('@dicebear/styles/icons.json'),
  },
  {
    id: 'initial-face',
    label: 'Initial Face',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/initial-face.json'),
  },
  {
    id: 'initials',
    label: 'Initials',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/initials.json'),
  },
  {
    id: 'thumbs',
    label: 'Thumbs',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/thumbs.json'),
  },
  {
    id: 'notionists',
    label: 'Notionists',
    category: 'avatars',
    creator: 'Zoish',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/notionists.json'),
  },
  {
    id: 'notionists-neutral',
    label: 'Notionists Neutral',
    category: 'avatars',
    creator: 'Zoish',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/notionists-neutral.json'),
  },
  {
    id: 'lorelei',
    label: 'Lorelei',
    category: 'avatars',
    creator: 'Lisa Wischofsky',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/lorelei.json'),
  },
  {
    id: 'lorelei-neutral',
    label: 'Lorelei Neutral',
    category: 'avatars',
    creator: 'Lisa Wischofsky',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/lorelei-neutral.json'),
  },
  {
    id: 'open-peeps',
    label: 'Open Peeps',
    category: 'avatars',
    creator: 'Pablo Stanley',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/open-peeps.json'),
  },
  {
    id: 'pixel-art',
    label: 'Pixel Art',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/pixel-art.json'),
  },
  {
    id: 'pixel-art-neutral',
    label: 'Pixel Art Neutral',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/pixel-art-neutral.json'),
  },
  {
    id: 'pixelbot',
    label: 'Pixelbot',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/pixelbot.json'),
  },
  {
    id: 'bottts',
    label: 'Bottts',
    category: 'avatars',
    creator: 'Pablo Stanley',
    license: 'Free for personal and commercial use',
    load: () => import('@dicebear/styles/bottts.json'),
  },
  {
    id: 'bottts-neutral',
    label: 'Bottts Neutral',
    category: 'avatars',
    creator: 'Pablo Stanley',
    license: 'Free for personal and commercial use',
    load: () => import('@dicebear/styles/bottts-neutral.json'),
  },
  {
    id: 'avataaars',
    label: 'Avataaars',
    category: 'avatars',
    creator: 'Pablo Stanley',
    license: 'Free for personal and commercial use',
    load: () => import('@dicebear/styles/avataaars.json'),
  },
  {
    id: 'avataaars-neutral',
    label: 'Avataaars Neutral',
    category: 'avatars',
    creator: 'Pablo Stanley',
    license: 'Free for personal and commercial use',
    load: () => import('@dicebear/styles/avataaars-neutral.json'),
  },
  {
    id: 'adventurer',
    label: 'Adventurer',
    category: 'avatars',
    creator: 'Lisa Wischofsky',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/adventurer.json'),
  },
  {
    id: 'adventurer-neutral',
    label: 'Adventurer Neutral',
    category: 'avatars',
    creator: 'Lisa Wischofsky',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/adventurer-neutral.json'),
  },
  {
    id: 'big-ears',
    label: 'Big Ears',
    category: 'avatars',
    creator: 'The Visual Team',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/big-ears.json'),
  },
  {
    id: 'big-ears-neutral',
    label: 'Big Ears Neutral',
    category: 'avatars',
    creator: 'The Visual Team',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/big-ears-neutral.json'),
  },
  {
    id: 'big-smile',
    label: 'Big Smile',
    category: 'avatars',
    creator: 'Ashley Seo',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/big-smile.json'),
  },
  {
    id: 'clay',
    label: 'Clay',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/clay.json'),
  },
  {
    id: 'critters',
    label: 'Critters',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/critters.json'),
  },
  {
    id: 'croodles',
    label: 'Croodles',
    category: 'avatars',
    creator: 'vijay verma',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/croodles.json'),
  },
  {
    id: 'croodles-neutral',
    label: 'Croodles Neutral',
    category: 'avatars',
    creator: 'vijay verma',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/croodles-neutral.json'),
  },
  {
    id: 'dylan',
    label: 'Dylan',
    category: 'avatars',
    creator: 'Natalia Spivak',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/dylan.json'),
  },
  {
    id: 'fun-emoji',
    label: 'Fun Emoji',
    category: 'avatars',
    creator: 'Davis Uche',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/fun-emoji.json'),
  },
  {
    id: 'micah',
    label: 'Micah',
    category: 'avatars',
    creator: 'Micah Lanier',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/micah.json'),
  },
  {
    id: 'miniavs',
    label: 'Miniavs',
    category: 'avatars',
    creator: 'Webpixels',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/miniavs.json'),
  },
  {
    id: 'moods',
    label: 'Moods',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/moods.json'),
  },
  {
    id: 'personas',
    label: 'Personas',
    category: 'avatars',
    creator: 'Draftbit - draftbit.com',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/personas.json'),
  },
  {
    id: 'sprouts',
    label: 'Sprouts',
    category: 'avatars',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/sprouts.json'),
  },
  {
    id: 'toon-head',
    label: 'Toon Head',
    category: 'avatars',
    creator: 'Johan Melin',
    license: 'CC BY 4.0',
    load: () => import('@dicebear/styles/toon-head.json'),
  },
  // ── backgrounds ─────────────────────────────────────────────────
  {
    id: 'shapes',
    label: 'Shapes',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/shapes.json'),
  },
  {
    id: 'identicon',
    label: 'Identicon',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/identicon.json'),
  },
  {
    id: 'loops',
    label: 'Loops',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/loops.json'),
  },
  {
    id: 'rings',
    label: 'Rings',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/rings.json'),
  },
  {
    id: 'squircles',
    label: 'Squircles',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/squircles.json'),
  },
  {
    id: 'shape-grid',
    label: 'Shape Grid',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/shape-grid.json'),
  },
  {
    id: 'glass',
    label: 'Glass',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/glass.json'),
  },
  {
    id: 'blobs',
    label: 'Blobs',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/blobs.json'),
  },
  {
    id: 'disco',
    label: 'Disco',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/disco.json'),
  },
  {
    id: 'stripes',
    label: 'Stripes',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/stripes.json'),
  },
  {
    id: 'triangles',
    label: 'Triangles',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/triangles.json'),
  },
  {
    id: 'waves',
    label: 'Waves',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/waves.json'),
  },
  {
    id: 'weave',
    label: 'Weave',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/weave.json'),
  },
  {
    id: 'constellation',
    label: 'Constellation',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/constellation.json'),
  },
  {
    id: 'landscape',
    label: 'Landscape',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/landscape.json'),
  },
  {
    id: 'planets',
    label: 'Planets',
    category: 'backgrounds',
    creator: 'DiceBear',
    license: 'CC0 1.0',
    load: () => import('@dicebear/styles/planets.json'),
  },
];
export const AVATAR_STYLE_IDS: readonly string[] = AVATAR_STYLES.map((s) => s.id);

/** The styles the AVATAR picker offers. */
export const AVATAR_PICKER_STYLES: AvatarStyleMeta[] = AVATAR_STYLES.filter(
  (s) => s.category === 'avatars',
);

/** The styles a BACKGROUND picker offers. */
export const BACKGROUND_STYLES: AvatarStyleMeta[] = AVATAR_STYLES.filter(
  (s) => s.category === 'backgrounds',
);

/**
 * Was `shapes`, which is now a background. Nothing was migrated: a brain that
 * explicitly saved a style keeps it, and `resolveAvatarStyle` still resolves
 * every id in the registry regardless of category, rendering never cared about
 * the split. Only a brain that never chose one moves, and it moves to a style
 * that is actually an avatar.
 */
export const DEFAULT_AVATAR_STYLE = 'thumbs';

/**
 * How much of the theme an avatar takes on.
 *
 * - `native` — the style's own palette, untouched. Loudest and most
 *   distinguishable, but ignores the brain's theme entirely.
 * - `mixed` — the theme tints the BACKGROUND; the artwork keeps its native
 *   colours. On-theme without flattening the artwork, which is why it is the
 *   default: it is the setting that made seeds tell apart again.
 * - `theme` — the ramp is pushed into every colour group the style exposes.
 *   Most on-theme, least varied; character styles expose no groups, so for
 *   them this is identical to `mixed`.
 */
export type AvatarTint = 'native' | 'mixed' | 'theme';

export const AVATAR_TINTS: Array<{ id: AvatarTint; label: string; hint: string }> = [
  { id: 'native', label: 'Original', hint: 'The style’s own colours' },
  { id: 'mixed', label: 'Mixed', hint: 'Themed background, original artwork' },
  { id: 'theme', label: 'Theme', hint: 'Theme colours throughout' },
];

export const DEFAULT_AVATAR_TINT: AvatarTint = 'mixed';

export function resolveAvatarTint(v: string | null | undefined): AvatarTint {
  return v === 'native' || v === 'theme' || v === 'mixed' ? v : DEFAULT_AVATAR_TINT;
}

/** boring-avatars variant → nearest shipped style. Stored avatars carry the old
 *  ids, so they are translated on READ rather than migrated: nobody's avatar
 *  vanishes, and re-saving is not required to get a valid one. */
const LEGACY_STYLES: Record<string, string> = {
  beam: 'thumbs',
  bauhaus: 'shapes',
  geometric: 'thumbs', // deprecated boring-avatars alias
  abstract: 'shapes', // deprecated boring-avatars alias
  marble: 'glass',
  sunset: 'glass',
  pixel: 'identicon',
  ring: 'rings',
};

/** Resolve any stored style id — current, legacy, empty or unknown — to a
 *  style that exists. Never throws; unknown ids fall back to the default. */
export function resolveAvatarStyle(id: string | null | undefined): string {
  if (!id) return DEFAULT_AVATAR_STYLE;
  if (AVATAR_STYLE_IDS.includes(id)) return id;
  return LEGACY_STYLES[id] ?? DEFAULT_AVATAR_STYLE;
}

export function avatarStyleMeta(id: string): AvatarStyleMeta {
  const resolved = resolveAvatarStyle(id);
  return AVATAR_STYLES.find((s) => s.id === resolved) ?? AVATAR_STYLES[0]!;
}

/** A parsed style, the colour groups `theme` tint may safely override, and the
 *  component variants the style declares. */
export type Loaded = {
  style: Style;
  tintGroups: string[];
  /** component name → the variant names it offers, e.g. `rotation` →
   *  `['quarter', 'none', 'free']`. Empty for styles that declare none. */
  variants: Record<string, string[]>;
  /** Components the style may leave out (declared probability < 100). Only
   *  these accept `null` ("hide it") in {@link AvatarParts}. */
  optional: string[];
};

/**
 * Which of a style's declared colour groups the `theme` tint is allowed to
 * repaint.
 *
 * Groups carrying `contrastTo` are EXCLUDED, and that exclusion is the whole
 * reason this function exists. Those groups are not decoration — they are the
 * legible part drawn ON another group, and DiceBear solves them to black or
 * white for contrast: `initials` text on its background, the `icons` glyph,
 * `thumbs`' eyes and mouth. Painting them from the same 5-colour ramp as the
 * surface behind them is a coin-flip on whether the avatar still has a face.
 *
 * `background` is excluded too, but only because it is already covered by the
 * core `backgroundColor` option every tint above `native` passes.
 */
function tintableGroups(json: unknown): string[] {
  const colors = (json as { colors?: Record<string, unknown> } | null)?.colors;
  if (!colors) return [];
  return Object.entries(colors)
    .filter(([name, spec]) => {
      if (name === 'background') return false;
      return !(spec && typeof spec === 'object' && 'contrastTo' in spec);
    })
    .map(([name]) => name);
}

/**
 * The component variants a style declares, as `{ component: [variant, …] }`.
 *
 * DiceBear validates options against a fixed set of patterns and THROWS on an
 * unknown key, so `rotationVariant` may only be passed to a style that actually
 * has a `rotation` component. Reading the declaration is the only way to know;
 * guessing by style id would break the moment a style is added or renamed.
 */
function componentVariants(json: unknown): Pick<Loaded, 'variants' | 'optional'> {
  const components = (json as { components?: Record<string, unknown> } | null)?.components;
  if (!components) return { variants: {}, optional: [] };
  const variants: Record<string, string[]> = {};
  const optional: string[] = [];
  for (const [name, spec] of Object.entries(components)) {
    // Alias components (`extends`) declare no variants of their own — skipped,
    // like every other component without a variants map.
    const s = spec as { variants?: Record<string, unknown>; probability?: number } | null;
    if (!s?.variants) continue;
    variants[name] = Object.keys(s.variants);
    if (typeof s.probability === 'number' && s.probability < 100) optional.push(name);
  }
  return { variants, optional };
}

// `Style` parses and validates the JSON once; building one per render would
// re-do that for every avatar in a list. Populated by loadAvatarStyle and kept
// for the life of the process — a style is a few hundred KB at most and the
// app realistically touches one.
const STYLES = new Map<string, Loaded>();
const INFLIGHT = new Map<string, Promise<Loaded>>();

/** Whether `renderAvatarSvgSync` can draw this style right now (its JSON chunk
 *  has already been fetched). React uses this to decide whether to await. */
export function isAvatarStyleReady(id: string | null | undefined): boolean {
  return STYLES.has(resolveAvatarStyle(id));
}

/** The parsed style, if its JSON chunk has already been fetched. Lets callers
 *  that render something other than an avatar (the backdrop) reuse this
 *  module's one cache rather than parsing the same JSON a second time. */
export function loadedAvatarStyle(id: string | null | undefined): Loaded | null {
  return STYLES.get(resolveAvatarStyle(id)) ?? null;
}

/** Fetch and parse a style's JSON. Idempotent, and concurrent calls for the
 *  same style share one request. Rejects only if the chunk itself fails to
 *  load, which callers treat as "draw nothing" rather than an error state. */
export function loadAvatarStyle(id: string | null | undefined): Promise<Loaded> {
  const key = resolveAvatarStyle(id);
  const ready = STYLES.get(key);
  if (ready) return Promise.resolve(ready);
  const pending = INFLIGHT.get(key);
  if (pending) return pending;
  const p = avatarStyleMeta(key)
    .load()
    .then((mod) => {
      // A JSON module is the object itself under CJS interop and under
      // `.default` as ESM; both bundlers here have produced each at times.
      const json = (mod as { default?: unknown }).default ?? mod;
      const loaded: Loaded = {
        style: new Style(json as ConstructorParameters<typeof Style>[0]),
        tintGroups: tintableGroups(json),
        ...componentVariants(json),
      };
      STYLES.set(key, loaded);
      INFLIGHT.delete(key);
      return loaded;
    })
    .catch((err) => {
      INFLIGHT.delete(key);
      throw err;
    });
  INFLIGHT.set(key, p);
  return p;
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

/**
 * Explicit per-component choices layered over the seed: component name → the
 * variant to pin, or `null` to hide an OPTIONAL component. Components the map
 * does not name keep their seed-picked look, so a stored choice set stays
 * valid as the user re-rolls the seed underneath it. Unknown components and
 * variants are DROPPED, not rejected — a choice saved under one brain style
 * must never make an avatar throw after the brain switches styles.
 */
export type AvatarParts = Record<string, string | null>;

export type RenderAvatarOptions = {
  /** Stored style id; legacy and unknown ids are resolved, not rejected. */
  style?: string | null;
  /** Stable per-entity seed — the same seed always yields the same avatar. */
  seed: string;
  /** Explicit component choices layered over the seed; see {@link AvatarParts}. */
  parts?: AvatarParts | null;
  /** Rendered px. Sets the root svg width/height; the viewBox scales. */
  size?: number;
  /** The theme's chart ramp, as hex. Ignored when tint is `native`. */
  ramp?: readonly string[];
  /** Defaults to `mixed`. */
  tint?: AvatarTint;
};

function draw(loaded: Loaded, { seed, size = 40, ramp, tint, parts }: RenderAvatarOptions): string {
  const colors = hexOnly(ramp);
  const opts: Record<string, unknown> = { seed: seed || 'mantle', size };
  const mode = resolveAvatarTint(tint);
  if (colors && mode !== 'native') {
    // `backgroundColor` is a CORE option, so it lands on every style — including
    // the character styles, which declare no colour groups at all. Without it,
    // theming would be a silent no-op for most of the set.
    opts.backgroundColor = colors;
    if (mode === 'theme') {
      for (const g of loaded.tintGroups) opts[`${g}Color`] = colors;
    }
  }
  if (parts) {
    for (const [component, variant] of Object.entries(parts)) {
      // DiceBear throws on options for components the style does not declare,
      // so only choices the loaded style recognises may pass (see the note on
      // componentVariants). Everything else is a stale choice — ignore it.
      const known = loaded.variants[component];
      if (!known) continue;
      if (variant === null) {
        // "Hide it" — only meaningful for components the style may omit.
        if (loaded.optional.includes(component)) opts[`${component}Probability`] = 0;
        continue;
      }
      if (!known.includes(variant)) continue;
      opts[`${component}Variant`] = variant;
      // A pinned variant must actually show: probability rolls independently
      // of variant choice, so an optional component needs the 100 as well.
      if (loaded.optional.includes(component)) opts[`${component}Probability`] = 100;
    }
  }
  return new Avatar(loaded.style, opts).toString();
}

/** Render an avatar SYNCHRONOUSLY. Returns null when the style's JSON has not
 *  been fetched yet — call `loadAvatarStyle` and render again. This shape
 *  exists for React, which cannot await inside a render. */
export function renderAvatarSvgSync(opts: RenderAvatarOptions): string | null {
  const loaded = STYLES.get(resolveAvatarStyle(opts.style));
  return loaded ? draw(loaded, opts) : null;
}

/** Render an avatar, fetching the style first if needed. The natural form
 *  outside React — used by the agent-avatar route. Pure and deterministic:
 *  same inputs, same bytes, in the browser and on the server alike. */
export async function renderAvatarSvg(opts: RenderAvatarOptions): Promise<string> {
  return draw(await loadAvatarStyle(opts.style), opts);
}

/** A short, stable seed for a brand-new avatar. */
export function randomAvatarSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}
