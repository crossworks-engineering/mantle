/**
 * Shared avatar metadata + helpers. The actual SVG is rendered by the
 * <BoringAvatar> component (components/boring-avatar.tsx) using boring-avatars.
 */

/** boring-avatars variants offered for randomization. Must stay in sync with
 *  components/boring-avatar.tsx. */
export const AVATAR_STYLE_IDS = ['beam', 'marble', 'sunset', 'pixel', 'ring', 'bauhaus'] as const;

export type AvatarStyleId = (typeof AVATAR_STYLE_IDS)[number];

export const DEFAULT_AVATAR_STYLE: AvatarStyleId = 'beam';

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function randomStyle(): string {
  return (
    AVATAR_STYLE_IDS[Math.floor(Math.random() * AVATAR_STYLE_IDS.length)] ?? DEFAULT_AVATAR_STYLE
  );
}
