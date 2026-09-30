/**
 * The level an item is read at (folder plan phase 4): its own level, or the
 * share it inherits from a folder when that is more open (content-core
 * effectiveLevel). What its embeds follow and its page text is folded for.
 * A module of its own so the embed closure and the page text can both use it
 * without importing each other.
 */
import { inArray, or, sql, type SQL } from 'drizzle-orm';
import { asViewerLevel, nodes, type ViewerLevel } from '@mantle/db';
import { effectiveLevel } from '@mantle/content-core/tree';

export function itemLevel(audience: string, inheritedLevel?: string | null): ViewerLevel {
  const inherited =
    inheritedLevel === 'team' || inheritedLevel === 'client' ? inheritedLevel : null;
  return effectiveLevel(asViewerLevel(audience), inherited);
}

/**
 * Is an item read at one of `levels`? By its own level, OR by the share it
 * inherits from a folder holding it: the union rule the row policy
 * (nodes_viewer_read) uses. Not the same as "its effective level is in
 * `levels`": a public item in a folder shared with the team is read by the
 * team through the folder, although it is public in its own right.
 */
export function isReadAt(
  audience: string,
  inheritedLevel: string | null | undefined,
  levels: readonly string[],
): boolean {
  return levels.includes(audience) || (!!inheritedLevel && levels.includes(inheritedLevel));
}

/** `isReadAt` as SQL over `nodes`: false when `levels` is empty. */
export function readAtSql(levels: readonly string[]): SQL {
  return levels.length
    ? or(inArray(nodes.audience, [...levels]), inArray(nodes.inheritedLevel, [...levels]))!
    : sql`false`;
}
