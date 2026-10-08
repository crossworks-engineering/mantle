/**
 * A page's indexed text at its level (client logins plan 3.3 point 4, N13;
 * audit B1). `pages.doc_text` is what the extractor summarises, chunks and
 * embeds and what search matches, so for a page a client or the public
 * reads it must hold only what that reader may read:
 *
 *  - an embedded file or drawing folds its text in only when the page's
 *    level reads it (a client page: client items; a public page: public
 *    items; `levelCovers`);
 *  - a mention chip, a link and a child page card of an item the page's
 *    level cannot read are written as "Private item" (a readable one carries
 *    its item's current title);
 *  - a team or admin page is unchanged: the whole doc and every embed.
 *
 * The filter is the client redactor (client-redact.ts) with the page's level
 * deciding what is readable, so a client page's text says what a client
 * reads of it. When a level changes (the page's own, or an item it names),
 * `refoldPageTexts` recomputes the text of the pages concerned: plain SQL and
 * TypeScript, and NOTHING else. It never announces the page to the
 * extractor, so its summary, chunks and embedding stay as they were until
 * the page is next committed (cost safety: no level change may start LLM
 * work).
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { asViewerLevel, db, levelCovers, nodes, pages, type ViewerLevel } from '@mantle/db';
import { docToText } from '../doc-to-text';
import {
  clientOwnUrl,
  docRefIds,
  noteRefIds,
  redactClientDoc,
  redactClientNote,
} from '../client-redact';
import { clientRedactOrigins } from '../client-origins';
import { embeddedAssetText } from './embed';
import { itemLevel } from '../item-level';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The pool, or a caller's transaction (the level writes run in one). */
export type LevelTextDb = typeof db | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The levels whose readers do not read every other item: their pages'
 *  text is filtered. */
const FILTERED: ReadonlySet<ViewerLevel> = new Set(['client', 'public']);

/** Whether a page at `level` gets a filtered text. */
export function filtersPageText(level: ViewerLevel): boolean {
  return FILTERED.has(level);
}

/** The items among `ids` a reader at `level` reads, with their titles. The
 *  owner's items only. Keys lower-case. */
async function readableAt(
  ownerId: string,
  level: ViewerLevel,
  ids: readonly string[],
  q: LevelTextDb,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i) => UUID.test(i)).map((i) => i.toLowerCase()))];
  if (!wanted.length) return new Map();
  const rows = await q
    .select({
      id: nodes.id,
      title: nodes.title,
      audience: nodes.audience,
      inheritedLevel: nodes.inheritedLevel,
      embeddedLevel: nodes.embeddedLevel,
    })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, wanted)));
  // A reader reads a row at its own level, its inherited share or the share
  // of something that embeds it (nodes_viewer_read, migrations 0204 and
  // 0208): the same union here.
  return new Map(
    rows
      .filter(
        (r) =>
          levelCovers(level, asViewerLevel(r.audience)) ||
          (!!r.inheritedLevel && levelCovers(level, asViewerLevel(r.inheritedLevel))) ||
          (!!r.embeddedLevel && levelCovers(level, asViewerLevel(r.embeddedLevel))),
      )
      .map((r) => [r.id.toLowerCase(), r.title]),
  );
}

/** The page document as a reader at `level` reads it (see the top). A team
 *  or admin page's doc comes back as it is. */
export async function levelFilteredDoc(
  ownerId: string,
  level: ViewerLevel,
  doc: unknown,
  q: LevelTextDb = db,
): Promise<unknown> {
  if (!filtersPageText(level)) return doc;
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await readableAt(ownerId, level, docRefIds(doc, { ownUrl }), q);
  return redactClientDoc(doc, new Set(titles.keys()), {
    ownUrl,
    titles,
    hiddenChildPage: 'label',
  });
}

/** A note's markdown as a reader at `level` reads it: the same rule as a
 *  page's doc (an item the level cannot read is "Private item", a picture
 *  of one is left out). A team or admin note comes back as it is. */
export async function levelFilteredNote(
  ownerId: string,
  level: ViewerLevel,
  markdown: string,
  q: LevelTextDb = db,
): Promise<string> {
  if (!filtersPageText(level)) return markdown;
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await readableAt(ownerId, level, noteRefIds(markdown, { ownUrl }), q);
  return redactClientNote(markdown, new Set(titles.keys()), { ownUrl, titles });
}

/**
 * The `doc_text` of a page at `level`: its (filtered) doc as text, and the
 * text of the files and drawings it embeds (only readable ones remain in a
 * filtered doc). `assets: false` leaves the embed text out (updatePage's
 * programmatic write, as before).
 */
export async function pageDocText(
  ownerId: string,
  level: ViewerLevel,
  doc: unknown,
  q: LevelTextDb = db,
  opts: { assets?: boolean } = {},
): Promise<string> {
  const shown = await levelFilteredDoc(ownerId, level, doc, q);
  const base = docToText(shown);
  if (opts.assets === false) return base;
  const assetText = await embeddedAssetText(ownerId, shown, q);
  return assetText ? `${base}\n\n${assetText}` : base;
}

/**
 * Re-fold `doc_text` after levels changed (`changedIds`: every item whose
 * level moved): the changed items that are pages (their own level decides
 * their filter), and every client or public page of the owner whose doc names
 * a changed item (whether that item is readable at the page's level may have
 * changed). Writes `doc_text` only, and only when it differs: no summary,
 * embedding, chunk or version change, no extractor announcement. Returns how
 * many pages were rewritten.
 */
export async function refoldPageTexts(
  ownerId: string,
  changedIds: readonly string[],
  q: LevelTextDb = db,
): Promise<number> {
  const ids = [...new Set(changedIds.filter((i) => UUID.test(i)).map((i) => i.toLowerCase()))];
  if (!ids.length) return 0;
  const names = sql.join(
    ids.map((id) => sql`${pages.doc}::text ilike ${`%${id}%`}`),
    sql` or `,
  );
  const rows = await q
    .select({
      id: nodes.id,
      audience: nodes.audience,
      inheritedLevel: nodes.inheritedLevel,
      embeddedLevel: nodes.embeddedLevel,
      doc: pages.doc,
      docText: pages.docText,
    })
    .from(pages)
    .innerJoin(nodes, eq(nodes.id, pages.nodeId))
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        or(
          inArray(pages.nodeId, ids),
          and(
            or(
              inArray(nodes.audience, [...FILTERED]),
              eq(nodes.inheritedLevel, 'client'),
              eq(nodes.embeddedLevel, 'client'),
            ),
            sql`(${names})`,
          ),
        ),
      ),
    );
  let written = 0;
  for (const r of rows) {
    const text = await pageDocText(
      ownerId,
      itemLevel(r.audience, r.inheritedLevel, r.embeddedLevel),
      r.doc,
      q,
    );
    if (text === r.docText) continue;
    await q.update(pages).set({ docText: text }).where(eq(pages.nodeId, r.id));
    written += 1;
  }
  return written;
}
