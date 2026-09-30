/**
 * The level an item is read at (folder plan phase 4): its own level, or the
 * share it inherits from a folder, or the share of something that embeds it
 * (migration 0208), whichever is most open (content-core effectiveLevel). What its embeds follow and its page text is folded for.
 * A module of its own so the embed closure and the page text can both use it
 * without importing each other.
 */
import { inArray, or, sql, type SQL } from 'drizzle-orm';
import { asViewerLevel, nodes, type ViewerLevel } from '@mantle/db';
import { effectiveLevel } from '@mantle/content-core/tree';

export function itemLevel(
  audience: string,
  inheritedLevel?: string | null,
  embeddedLevel?: string | null,
): ViewerLevel {
  return effectiveLevel(asViewerLevel(audience), asShare(inheritedLevel), asShare(embeddedLevel));
}

function asShare(level: string | null | undefined): 'team' | 'client' | null {
  return level === 'team' || level === 'client' ? level : null;
}

/** Leave out the embedded level: the client thread (0205) belongs to the
 *  item that embeds, never to what it embeds. */
export type ReadAtOpts = { embeds?: boolean };

/**
 * Is an item read at one of `levels`? By its own level, OR by the share it
 * inherits from a folder holding it, OR by the share of something that
 * embeds it (migration 0208): the union rule the row policy
 * (nodes_viewer_read) uses. Not the same as "its effective level is in
 * `levels`": a public item in a folder shared with the team is read by the
 * team through the folder, although it is public in its own right.
 */
export function isReadAt(
  audience: string,
  inheritedLevel: string | null | undefined,
  levels: readonly string[],
  embeddedLevel?: string | null,
): boolean {
  return (
    levels.includes(audience) ||
    (!!inheritedLevel && levels.includes(inheritedLevel)) ||
    (!!embeddedLevel && levels.includes(embeddedLevel))
  );
}

/** `isReadAt` as SQL over `nodes`: false when `levels` is empty. */
export function readAtSql(levels: readonly string[], opts: ReadAtOpts = {}): SQL {
  if (!levels.length) return sql`false`;
  const list = [...levels];
  return or(
    inArray(nodes.audience, list),
    inArray(nodes.inheritedLevel, list),
    ...(opts.embeds === false ? [] : [inArray(nodes.embeddedLevel, list)]),
  )!;
}

/** `readAtSql` on a raw query's alias (`n.audience`, `n.inherited_level`,
 *  `n.embedded_level`). */
export function readAtAliasSql(
  alias: string,
  levels: readonly string[],
  opts: ReadAtOpts = {},
): SQL {
  if (!levels.length) return sql`false`;
  const a = sql.raw(alias);
  const list = sql.join(
    levels.map((l) => sql`${l}`),
    sql`, `,
  );
  const embedded = opts.embeds === false ? sql`` : sql` or ${a}.embedded_level in (${list})`;
  return sql`(${a}.audience in (${list}) or ${a}.inherited_level in (${list})${embedded})`;
}
