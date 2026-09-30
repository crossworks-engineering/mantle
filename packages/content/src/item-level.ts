/**
 * The level an item is read at (folder plan phase 4): its own level, or the
 * share it inherits from a folder when that is more open (content-core
 * effectiveLevel). What its embeds follow and its page text is folded for.
 * A module of its own so the embed closure and the page text can both use it
 * without importing each other.
 */
import { asViewerLevel, type ViewerLevel } from '@mantle/db';
import { effectiveLevel } from '@mantle/content-core/tree';

export function itemLevel(audience: string, inheritedLevel?: string | null): ViewerLevel {
  const inherited =
    inheritedLevel === 'team' || inheritedLevel === 'client' ? inheritedLevel : null;
  return effectiveLevel(asViewerLevel(audience), inherited);
}
