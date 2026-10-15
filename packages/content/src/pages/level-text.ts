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
 *    it is "Private item". An entity mention chip always keeps its label:
 *    it is text the author typed, the page's own words.
 *
 * A page no workspace holds (a personal space's page) is not filtered. When
 * grants change (the page's, or an item it names), `refoldPageTexts`
 * recomputes the text of the pages concerned: plain SQL and TypeScript, and
 * NOTHING else. It never announces the page to the extractor (cost safety: no
 * grant change may start LLM work).
 *
 * `servedFilteredDoc` and `servedFilteredNote` are the open-link render rule
 * (the share pages): a link shows the items on its served list.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, holdsAllSql, itemHoldersTextSql, nodes, pages } from '@mantle/db';
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

/** The titles of the owner's items among `ids` that are in `served`. Keys
 *  lower-case. */
async function servedTitles(
  ownerId: string,
  served: ReadonlySet<string>,
  ids: readonly string[],
  q: LevelTextDb,
): Promise<Map<string, string>> {
  const wanted = [
    ...new Set(
      ids
        .filter((i) => UUID.test(i))
        .map((i) => i.toLowerCase())
        .filter((i) => served.has(i)),
    ),
  ];
  if (!wanted.length) return new Map();
  const rows = await q
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, wanted)));
  return new Map(rows.map((r) => [r.id.toLowerCase(), r.title]));
}

/**
 * A page document as an open link shows it (workspaces plan 8.1): a mention,
 * a link or a child page card of an item not in `served` (lower-case ids:
 * the link's item and its served list) reads "Private item", and an embed of
 * one is left out. A served item's mention carries its current title.
 */
export async function servedFilteredDoc(
  ownerId: string,
  served: ReadonlySet<string>,
  doc: unknown,
  q: LevelTextDb = db,
): Promise<unknown> {
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await servedTitles(ownerId, served, docRefIds(doc, { ownUrl }), q);
  return redactClientDoc(doc, new Set(titles.keys()), {
    ownUrl,
    titles,
    hiddenChildPage: 'label',
  });
}

/** A note's (a task's, an event's) markdown as an open link shows it: the
 *  rule of {@link servedFilteredDoc} (an item not served is "Private item",
 *  a picture of one is left out). */
export async function servedFilteredNote(
  ownerId: string,
  served: ReadonlySet<string>,
  markdown: string,
  q: LevelTextDb = db,
): Promise<string> {
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await servedTitles(ownerId, served, noteRefIds(markdown, { ownUrl }), q);
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
 *  hold (lower-case id to current title). */
type HolderView = { held: ReadonlyMap<string, string>; ownUrl: OwnUrl };

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
    select ${itemHoldersTextSql('n')} as ws
      from nodes n where n.id = ${pageId}::uuid`)) as unknown as Array<{ ws: string }>;
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
          holdsAllSql(undefined, uuidArray(holders)),
        ),
      );
    for (const r of rows) held.set(r.id.toLowerCase(), r.title);
  }
  return { held, ownUrl };
}

/** Whether a link mark names an item not every holder holds. A target that
 *  names no item (an external link, an entity) stays. */
function linkHidden(m: PMMark, v: HolderView): boolean {
  return pageRefs({ type: 'text', marks: [m] }, v.ownUrl).ids.some((id) => !v.held.has(id));
}

function privateMention(n: PMNode): PMNode {
  return { ...n, attrs: { id: null, label: CLIENT_PRIVATE_LABEL, ref: null, kind: null } };
}

function foldNode(n: PMNode, v: HolderView): PMNode {
  if (!n || typeof n !== 'object') return n;
  let out: PMNode = n;
  // A node mention follows the holder rule; an entity mention keeps its label.
  if (n.type === 'mention' && n.attrs?.ref === 'node') {
    const a = n.attrs;
    const title = typeof a.id === 'string' ? v.held.get(a.id.toLowerCase()) : undefined;
    out = title === undefined ? privateMention(n) : { ...n, attrs: { ...a, label: title } };
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
  if (!refs.ids.length) return docToText(doc, { embedMarkers: true });
  const view = await holderView(ownerId, ws, refs.ids, ownUrl, q);
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
      ws: itemHoldersTextSql(),
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
