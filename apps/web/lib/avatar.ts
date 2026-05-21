/**
 * Client-safe avatar helpers. Deliberately imports NO @dicebear code so it
 * can be used in client components without pulling the (large) style
 * generators into the browser bundle. The actual SVG is produced server-side
 * by GET /api/avatar (see lib/dicebear.ts).
 */

/** Style ids offered for randomization. Must stay in sync with the id→style
 *  map in lib/dicebear.ts (which holds the generator functions). */
export const AVATAR_STYLE_IDS = [
  'funEmoji',
  'thumbs',
  'bottts',
  'botttsNeutral',
  'lorelei',
  'adventurer',
  'avataaars',
  'micah',
  'notionists',
  'openPeeps',
  'personas',
  'bigSmile',
  'pixelArt',
  'shapes',
  'identicon',
  'glass',
  'icons',
] as const;

export type AvatarStyleId = (typeof AVATAR_STYLE_IDS)[number];

export const DEFAULT_AVATAR_STYLE: AvatarStyleId = 'funEmoji';

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function randomStyle(): string {
  return AVATAR_STYLE_IDS[Math.floor(Math.random() * AVATAR_STYLE_IDS.length)] ?? DEFAULT_AVATAR_STYLE;
}

/** URL for an avatar SVG served by the API route. Cacheable + keeps DiceBear
 *  out of the client bundle. */
export function avatarUrl(style: string, seed: string): string {
  const qs = new URLSearchParams({ style: style || DEFAULT_AVATAR_STYLE, seed: seed || 'mantle' });
  return `/api/avatar?${qs.toString()}`;
}
