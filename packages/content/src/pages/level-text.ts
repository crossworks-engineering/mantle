/**
 * A page's indexed text (workspaces plan 5.3: derived text holds only the
 * item's own words). `pages.doc_text` is what the extractor summarises,
 * chunks and embeds and what search matches, so:
 *
 *  - an embedded file, drawing or child page is a plain marker
 *    ("[embedded file]"): its words are indexed on the item itself and found
 *    through its own grants;
 *  - a mention chip or a link of another item carries that item's current
 *    title only when EVERY workspace that holds the page also holds that
 *    item (the item's read_ws contains all of the page's read_ws); otherwise
 *    it is "Private item". An entity mention (entities live in Admin only)
 *    keeps its label only on a page that Admin alone holds.
 *
 * A page no workspace holds (a personal space's page) is not filtered. When
 * grants change (the page's, or an item it names), `refoldPageTexts`
 * recomputes the text of the pages concerned: plain SQL and TypeScript, and
 * NOTHING else. It never announces the page to the extractor (cost safety: no
 * grant change may start LLM work).
 *
 * `levelFilteredDoc` and `levelFilteredNote` are the open-link render rule
 * (the share pages) and still read levels: the links work replaces them.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { asViewerLevel, db, levelCovers, nodes, pages, type ViewerLevel } from '@mantle/db';
import { CLIENT_PRIVATE_LABEL } from '@mantle/client-types/dto/client';
import { docToText } from '../doc-to-text';
import {
  clientOwnUrl,
  docRefIds,
  noteRefIds,
  redactClientDoc,
  redactClientNote,
} from '../client-redact';
import { clientRedactOrigins } from '../client-origins';
import { pageRefs, type OwnUrl } from '../embed-refs';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The pool, or a caller's transaction. */
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

// ── The grants fold (doc_text) ───────────────────────────────────────────────

type PMMark = { type?: string; attrs?: Record<string, unknown> };
type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
  text?: string;
};

/** What every holder of a page reads, for its fold: the named items they all
 *  hold (lower-case id to current title), and whether entity mentions are
 *  theirs (Admin alone holds the page). */
type HolderView = { held: ReadonlyMap<string, string>; entities: boolean; ownUrl: OwnUrl };

/** A uuid array literal for the workspaces in `ids`. */
function uuidArray(ids: readonly string[]) {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}

/** The workspaces that hold `pageId` (its read_ws). Empty for a page no
 *  workspace holds (a personal space's page) or one that is gone. */
export async function pageHolders(pageId: string, q: LevelTextDb = db): Promise<string[]> {
  if (!UUID.test(pageId)) return [];
  const [row] = (await q.execute(sql`
    select coalesce(array_to_string(read_ws, ','), '') as ws
      from nodes where id = ${pageId}::uuid`)) as unknown as Array<{ ws: string }>;
  return wsList(row?.ws);
}

function wsList(ws: string | null | undefined): string[] {
  return ws ? ws.split(',').filter((w) => UUID.test(w)) : [];
}

/** The view of a page held by `holders`, for the ids its doc names. */
async function holderView(
  ownerId: string,
  holders: readonly string[],
  ids: readonly string[],
  withEntities: boolean,
  ownUrl: OwnUrl,
  q: LevelTextDb,
): Promise<HolderView> {
  const wanted = [...new Set(ids.filter((i) => UUID.test(i)).map((i) => i.toLowerCase()))];
  const held = new Map<string, string>();
  if (wanted.length) {
    const rows = await q
      .select({ id: nodes.id, title: nodes.title })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          inArray(nodes.id, wanted),
          sql`${nodes}.read_ws @> ${uuidArray(holders)}`,
        ),
      );
    for (const r of rows) held.set(r.id.toLowerCase(), r.title);
  }
  let entities = false;
  if (withEntities) {
    const [admin] = (await q.execute(sql`
      select id::text as id from workspaces
       where owner_id = ${ownerId}::uuid and is_admin limit 1`)) as unknown as Array<{
      id: string;
    }>;
    entities = !!admin && holders.every((h) => h.toLowerCase() === admin.id.toLowerCase());
  }
  return { held, entities, ownUrl };
}

/** Whether a link mark names an item not every holder holds (or an entity
 *  they do not all read). A target that names no item stays. */
function linkHidden(m: PMMark, v: HolderView): boolean {
  const refs = pageRefs({ type: 'text', marks: [m] }, v.ownUrl);
  if (refs.ids.some((id) => !v.held.has(id))) return true;
  return !v.entities && refs.refused.some((r) => /^\s*mention:/i.test(r));
}

function privateMention(n: PMNode): PMNode {
  return { ...n, attrs: { id: null, label: CLIENT_PRIVATE_LABEL, ref: null, kind: null } };
}

function foldNode(n: PMNode, v: HolderView): PMNode {
  if (!n || typeof n !== 'object') return n;
  let out: PMNode = n;
  if (n.type === 'mention') {
    const a = n.attrs ?? {};
    if (a.ref === 'node') {
      const title = typeof a.id === 'string' ? v.held.get(a.id.toLowerCase()) : undefined;
      out = title === undefined ? privateMention(n) : { ...n, attrs: { ...a, label: title } };
    } else if (!v.entities) {
      out = privateMention(n);
    }
  }
  if (Array.isArray(n.content)) out = { ...out, content: foldContent(n.content, v) };
  return out;
}

/** A hidden link reads "Private item" once, however many text runs (bold
 *  here, plain there) it spans. */
function foldContent(kids: PMNode[], v: HolderView): PMNode[] {
  const out: PMNode[] = [];
  let lastHidden: string | null = null;
  for (const k of kids) {
    if (k && typeof k === 'object' && k.type === 'text' && k.marks?.length) {
      const hidden = k.marks.filter((m) => linkHidden(m, v));
      if (hidden.length) {
        const key = JSON.stringify(hidden.map((m) => m.attrs ?? {}));
        if (key !== lastHidden) {
          const label: PMNode = { ...k, text: CLIENT_PRIVATE_LABEL };
          delete label.marks;
          out.push(label);
        }
        lastHidden = key;
        continue;
      }
    }
    lastHidden = null;
    out.push(foldNode(k, v));
  }
  return out;
}

/**
 * The `doc_text` of a page that the workspaces `holders` hold (its read_ws):
 * its doc as text, with a plain marker for each item it embeds and none of
 * that item's words, and a mention or link of another item as that item's
 * title only when every holder holds it, else "Private item" (see the top).
 * No holders: the doc as it is (no database read).
 */
export async function pageDocText(
  ownerId: string,
  holders: readonly string[],
  doc: unknown,
  q: LevelTextDb = db,
): Promise<string> {
  const ws = holders.filter((h) => UUID.test(h));
  if (!ws.length || !doc || typeof doc !== 'object') {
    return docToText(doc, { embedMarkers: true });
  }
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const refs = pageRefs(doc, ownUrl);
  const withEntities = refs.refused.some((r) => /^\s*mention:/i.test(r));
  if (!refs.ids.length && !withEntities) return docToText(doc, { embedMarkers: true });
  const view = await holderView(ownerId, ws, refs.ids, withEntities, ownUrl, q);
  return docToText(foldNode(doc as PMNode, view), { embedMarkers: true });
}

/**
 * Re-fold `doc_text` after grants changed (`changedIds`: every item whose
 * grants moved): the changed items that are pages (their holders may have
 * changed), and every page of the owner whose doc names a changed item
 * (whether all its holders hold that item may have changed). Writes
 * `doc_text` only, and only when it differs: no summary, embedding, chunk or
 * version change, no extractor announcement. Returns how many pages were
 * rewritten.
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
      ws: sql<string>`coalesce(array_to_string(${nodes}.read_ws, ','), '')`,
      doc: pages.doc,
      docText: pages.docText,
    })
    .from(pages)
    .innerJoin(nodes, eq(nodes.id, pages.nodeId))
    .where(and(eq(nodes.ownerId, ownerId), or(inArray(pages.nodeId, ids), sql`(${names})`)));
  let written = 0;
  for (const r of rows) {
    const text = await pageDocText(ownerId, wsList(r.ws), r.doc, q);
    if (text === r.docText) continue;
    await q.update(pages).set({ docText: text }).where(eq(pages.nodeId, r.id));
    written += 1;
  }
  return written;
}
