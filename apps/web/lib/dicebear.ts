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
import { DEFAULT_AVATAR_STYLE } from '@/lib/avatar';

/**
 * Server-only DiceBear SVG generation. This module imports the (heavy) style
 * generators, so it must NOT be imported by client components — only the
 * `GET /api/avatar` route uses it. Client code builds avatar URLs via
 * lib/avatar (no @dicebear import).
 */

type AnyStyle = Style<Record<string, unknown>>;

const BY_ID: Record<string, AnyStyle> = {
  funEmoji: funEmoji as unknown as AnyStyle,
  thumbs: thumbs as unknown as AnyStyle,
  bottts: bottts as unknown as AnyStyle,
  botttsNeutral: botttsNeutral as unknown as AnyStyle,
  lorelei: lorelei as unknown as AnyStyle,
  adventurer: adventurer as unknown as AnyStyle,
  avataaars: avataaars as unknown as AnyStyle,
  micah: micah as unknown as AnyStyle,
  notionists: notionists as unknown as AnyStyle,
  openPeeps: openPeeps as unknown as AnyStyle,
  personas: personas as unknown as AnyStyle,
  bigSmile: bigSmile as unknown as AnyStyle,
  pixelArt: pixelArt as unknown as AnyStyle,
  shapes: shapes as unknown as AnyStyle,
  identicon: identicon as unknown as AnyStyle,
  glass: glass as unknown as AnyStyle,
  icons: icons as unknown as AnyStyle,
};

export function isAvatarStyle(id: string): boolean {
  return id in BY_ID;
}

/** Raw SVG markup for an avatar. Falls back to the default style for an
 *  unknown id and a stable seed for an empty one. */
export function avatarSvg(styleId: string, seed: string): string {
  const style = BY_ID[styleId] ?? BY_ID[DEFAULT_AVATAR_STYLE]!;
  return createAvatar(style, { seed: seed || 'mantle' }).toString();
}
