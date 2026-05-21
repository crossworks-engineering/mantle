import { createAvatar, type Style } from '@dicebear/core';
import {
  adventurer,
  avataaars,
  bigSmile,
  bottts,
  botttsNeutral,
  funEmoji,
  glass,
  icons,
  identicon,
  lorelei,
  micah,
  notionists,
  openPeeps,
  personas,
  pixelArt,
  shapes,
  thumbs,
} from '@dicebear/collection';

/**
 * DiceBear avatars. Each avatar is a deterministic SVG from a {style, seed}
 * pair — we persist just those two and render on the fly (no image storage).
 * Used for agent avatars (agents.avatar) and the user avatar
 * (profiles.preferences.avatar*).
 */

type AnyStyle = Style<Record<string, unknown>>;

export type AvatarStyleOption = { id: string; label: string; style: AnyStyle };

/** Curated set offered in the picker — a mix of human, character, and
 *  abstract styles that read well at small sizes. */
export const AVATAR_STYLES: AvatarStyleOption[] = [
  { id: 'funEmoji', label: 'Fun Emoji', style: funEmoji as unknown as AnyStyle },
  { id: 'thumbs', label: 'Thumbs', style: thumbs as unknown as AnyStyle },
  { id: 'bottts', label: 'Bottts', style: bottts as unknown as AnyStyle },
  { id: 'botttsNeutral', label: 'Bottts Neutral', style: botttsNeutral as unknown as AnyStyle },
  { id: 'lorelei', label: 'Lorelei', style: lorelei as unknown as AnyStyle },
  { id: 'adventurer', label: 'Adventurer', style: adventurer as unknown as AnyStyle },
  { id: 'avataaars', label: 'Avataaars', style: avataaars as unknown as AnyStyle },
  { id: 'micah', label: 'Micah', style: micah as unknown as AnyStyle },
  { id: 'notionists', label: 'Notionists', style: notionists as unknown as AnyStyle },
  { id: 'openPeeps', label: 'Open Peeps', style: openPeeps as unknown as AnyStyle },
  { id: 'personas', label: 'Personas', style: personas as unknown as AnyStyle },
  { id: 'bigSmile', label: 'Big Smile', style: bigSmile as unknown as AnyStyle },
  { id: 'pixelArt', label: 'Pixel Art', style: pixelArt as unknown as AnyStyle },
  { id: 'shapes', label: 'Shapes', style: shapes as unknown as AnyStyle },
  { id: 'identicon', label: 'Identicon', style: identicon as unknown as AnyStyle },
  { id: 'glass', label: 'Glass', style: glass as unknown as AnyStyle },
  { id: 'icons', label: 'Icons', style: icons as unknown as AnyStyle },
];

export const DEFAULT_AVATAR_STYLE = 'funEmoji';

const BY_ID = new Map(AVATAR_STYLES.map((s) => [s.id, s.style]));

export function isAvatarStyle(id: string): boolean {
  return BY_ID.has(id);
}

/** A `data:` URI for an avatar. Falls back to the default style for an
 *  unknown id and a stable seed for an empty one. Isomorphic — safe in
 *  both server and client components. */
export function avatarDataUri(styleId: string, seed: string): string {
  const style = BY_ID.get(styleId) ?? BY_ID.get(DEFAULT_AVATAR_STYLE)!;
  return createAvatar(style, { seed: seed || 'mantle' }).toDataUri();
}
