/**
 * Client-safe avatar helpers. Deliberately imports NO avatar-rendering code so
 * it can be used in client components without bundling the generator. The
 * actual SVG is produced server-side by GET /api/avatar (see lib/avatar-svg.ts,
 * which uses boring-avatars).
 */

/** boring-avatars variants offered for randomization. Must stay in sync with
 *  lib/avatar-svg.ts. */
export const AVATAR_STYLE_IDS = [
  'beam',
  'marble',
  'sunset',
  'pixel',
  'ring',
  'bauhaus',
] as const;

export type AvatarStyleId = (typeof AVATAR_STYLE_IDS)[number];

export const DEFAULT_AVATAR_STYLE: AvatarStyleId = 'beam';

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function randomStyle(): string {
  return AVATAR_STYLE_IDS[Math.floor(Math.random() * AVATAR_STYLE_IDS.length)] ?? DEFAULT_AVATAR_STYLE;
}

/** URL for an avatar SVG served by the API route. Cacheable + keeps the
 *  generator out of the client bundle. */
export function avatarUrl(style: string, seed: string): string {
  const qs = new URLSearchParams({ style: style || DEFAULT_AVATAR_STYLE, seed: seed || 'mantle' });
  return `/api/avatar?${qs.toString()}`;
}
