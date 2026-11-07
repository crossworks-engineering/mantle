/**
 * Web-side share helpers. Re-exports the owner-side CRUD from @mantle/content
 * and adds the PUBLIC read path: resolve a token → the data a presenter needs,
 * and the asset-scoping check the public file route enforces. None of this
 * calls requireOwner — the public surface trusts a resolved active token and
 * only ever reaches the one shared node plus what it serves.
 *
 * What an open link serves (workspaces plan 8.1, decision 12): its item, and
 * the items on its served list (`settings.served`) that the item still
 * names or embeds (a folder link: that still sit under the folder). A
 * contact share holds no list: it serves what its item names. A canvas's
 * open link serves the media its last save listed for the link
 * (`meta.linkAssets`, canvasMediaServable): media goes with its canvas, with
 * no switch. No level is read: the rule is the list, checked here on the
 * system pool per request.
 */
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, draws, itemHomeSql, nodes, tables, type Share } from '@mantle/db';
import { getPresentEmbedFacts } from '@mantle/content/presents';
import { CANVAS_MEDIA_MAX_BYTES, canvasMediaMime } from '@mantle/content-core/canvas-media';
import {
  drawPlacedFileIds,
  getPage,
  getApp,
  getDrawSvg,
  referencedDrawIds,
  referencedFileIds,
  referencedPresentIds,
  shareServedIds,
  ensureTableDoc,
  emptyTableDoc,
  parseFormulaSpec,
  checkLookupCoverage,
  checkDimensions,
  signatureOf,
  type AggregateKind,
  type Column,
  type Row,
  type FormulaSpec,
  type TargetSignature,
  type CoverageGap,
  type DimensionIssue,
} from '@mantle/content';
import { aggregateWindow, describeWorkbook, resolveStoragePath } from '@mantle/tabledb';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { isUuid } from '@mantle/std';
import { servedFilteredDoc, servedFilteredNote } from '@mantle/content/pages';
import { fileById, folderById } from '@/lib/files';

export {
  createShare,
  revokeShare,
  revokeShareTree,
  applyShareMode,
  getActiveShareForNode,
  getLiveShare,
  setShareServed,
  resolveActiveShareByToken,
  resolveActiveShareRowByToken,
  recordShareView,
  isShareable,
  type ShareSummary,
} from '@mantle/content';

export function buildShareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/s/${token}`;
}

/** The most ids one served list takes (POST and PATCH /api/shares). */
export const SERVE_MAX = 5000;

export type ShareView =
  | {
      kind: 'page';
      title: string;
      icon: string | null;
      width: 'narrow' | 'wide';
      doc: Record<string, unknown>;
    }
  | { kind: 'note'; title: string; content: string }
  | {
      kind: 'task';
      title: string;
      body: string;
      status: string;
      priority: string;
      dueAt: string | null;
      /** Read-only checklist snapshot — mirrors share-ui's view-payload. */
      todos?: { text: string; done: boolean }[];
    }
  | {
      kind: 'event';
      title: string;
      body: string;
      startsAt: string | null;
      endsAt: string | null;
      location: string | null;
      recur?: string | null;
      recurUntil?: string | null;
      tags?: string[];
    }
  | { kind: 'file'; fileId: string; filename: string; mimeType: string; size: number }
  | { kind: 'app'; appId: string; title: string }
  | { kind: 'present'; presentId: string; title: string }
  | {
      kind: 'table';
      tableId: string;
      title: string;
      icon: string | null;
      /** File-backed workbooks: tab list + the column set rows are keyed by
       *  (formula columns are not stored, so they don't appear on the public
       *  surface). Rows page in through GET /s/[token]/rows. */
      tabs: Array<{
        id: string;
        name: string;
        rowCount: number;
        columns: Array<{ id: string; name: string; type: string }>;
        /** The owner's footer totals: which kind per column, and the value
         *  computed HERE over every row. The value cannot be left to the
         *  reader — it holds one 200-row window, so a total taken from it is
         *  a wrong number wearing a right number's clothes. */
        aggregates: Record<string, AggregateKind>;
        aggregateValues: Record<string, number | null>;
      }> | null;
      /** Legacy JSONB tables (pre-registry, small): the whole doc inline.
       *  Aggregate SETTINGS only — these arrive whole, so the reader can
       *  compute its own totals and no round trip is involved. */
      legacyDoc: {
        columns: Column[];
        rows: Row[];
        aggregates: Record<string, AggregateKind>;
      } | null;
    }
  | {
      kind: 'formula';
      title: string;
      spec: FormulaSpec;
      /** Computed on read, never stored (docs/formulas.md §1). The public
       *  calculator builds its fields from this rather than re-deriving which
       *  symbols a target needs — the same contract the owner UI uses. */
      signature: TargetSignature[];
      coverageGaps: CoverageGap[];
      dimensionIssues: DimensionIssue[];
    }
  | {
      kind: 'folder';
      folderId: string;
      title: string;
      path: string;
      /** The link's served list (servedIds): never sent to the visitor, it
       *  filters the listing. */
      served: string[];
    }
  // Only WHETHER a committed snapshot exists (false when the last commit
  // carried none; the presenter shows a placeholder rather than 404ing a link
  // that was legitimately minted). The bytes are served separately, as an
  // image, by /s/<token>/draw.
  | { kind: 'draw'; title: string; hasSvg: boolean; hasImage?: boolean };

/** The ids an open link serves, lower-case: its item and its served list.
 *  Membership only: a page's, note's or drawing's caller still checks that
 *  the item names the id, a folder's that the id sits under the folder
 *  ({@link isServed}). */
export function servedIds(share: Pick<Share, 'nodeId' | 'settings'>): Set<string> {
  return new Set([share.nodeId.toLowerCase(), ...shareServedIds(share.settings)]);
}

/** The ids among `ids` that are the owner's read-only snapshot copies,
 *  lower-case. */
/** The ids among `ids` that are a login's own items (nodes.login_id set):
 *  no share serves one, whatever its kind (an open link, a folder link, a
 *  contact share), so neither a share of it nor an item that names or
 *  embeds it ever hands another login's private file out. */
export async function loginOwnedIds(ownerId: string, ids: Iterable<string>): Promise<Set<string>> {
  const list = [...ids].filter((id) => isUuid(id));
  if (!list.length) return new Set();
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        sql`${nodes.id} = any (${`{${list.join(',')}}`}::uuid[])`,
        sql`${nodes.loginId} is not null`,
      ),
    );
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/** Whether `nodeId`, read in the caller's scope, is another login's own
 *  item (nodes.login_id set and not `loginId`): the question the contact
 *  share route asks before its Admin act. An item the scope does not read
 *  answers false here; the act's definer refuses another login's own item
 *  whatever the scope reads (0366). */
export async function loginOwnedByAnother(nodeId: string, loginId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const [row] = await db
    .select({ loginId: nodes.loginId })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  return !!row?.loginId && row.loginId.toLowerCase() !== loginId.toLowerCase();
}

async function snapshotCopyIds(ownerId: string, ids: Iterable<string>): Promise<Set<string>> {
  const list = [...ids].filter((id) => isUuid(id));
  if (!list.length) return new Set();
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        sql`${nodes.id} = any (${`{${list.join(',')}}`}::uuid[])`,
        sql`coalesce(${nodes.data} ? 'snapshot_of', false)`,
      ),
    );
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/** {@link servedIds} as served now: a read-only snapshot copy is never
 *  served, whatever an older list holds. */
export async function liveServedIds(share: Share): Promise<Set<string>> {
  const served = servedIds(share);
  const self = share.nodeId.toLowerCase();
  for (const id of await snapshotCopyIds(share.ownerId, served)) {
    if (id !== self) served.delete(id);
  }
  return served;
}

/**
 * Does this share serve `nodeId` (plan 8.1)? Its own item, always. An open
 * link: an id on its served list, and for a folder link one that still sits
 * under the folder (moved out, it is not served on its next fetch). A
 * CONTACT share (migration 0214) holds no list: it serves what its item
 * names, read only and only while the share lives. Every caller also checks
 * that the item names or embeds the id (its own content), so a share never
 * becomes a way to read arbitrary items by id.
 */
export async function isServed(share: Share, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const id = nodeId.toLowerCase();
  // A login's own item is served by no share, of any kind (contact shares
  // included), even as the share's own item: the share was made by a
  // definer that names only the brain before 0366, so who made it is not
  // known here.
  if ((await loginOwnedIds(share.ownerId, [id])).has(id)) return false;
  if (id === share.nodeId.toLowerCase()) return true;
  // A read-only snapshot copy stays in its private workspace: no link and
  // no contact share serves it.
  const notCopy = async () => !(await snapshotCopyIds(share.ownerId, [id])).has(id);
  if (share.contactId) return notCopy();
  if (!servedIds(share).has(id)) return false;
  if (share.nodeType !== 'branch') return notCopy();
  const root = alias(nodes, 'share_root');
  const [hit] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(
      root,
      and(eq(root.id, share.nodeId), eq(root.ownerId, share.ownerId), eq(root.type, 'branch')),
    )
    .where(
      and(
        eq(nodes.id, id),
        eq(nodes.ownerId, share.ownerId),
        sql`${nodes.path} <@ ${root.path}`,
        sql`${nodes.id} <> ${root.id}`,
        sql`not coalesce(${nodes.data} ? 'snapshot_of', false)`,
      ),
    )
    .limit(1);
  return !!hit;
}

/**
 * May this share show this drawing's snapshot? The snapshot carries every
 * image the committed scene places, so every one of them must be served:
 * an image not on the list keeps the whole snapshot off the link (there is
 * no serving it without that image). `self`: the drawing is an EMBED (in a
 * shared page or note), so it must be served itself; a drawing that is the
 * shared item is the link.
 */
export async function isDrawServable(
  share: Share,
  drawId: string,
  opts: { self: boolean },
): Promise<boolean> {
  const [row] = await db
    .select({ scene: draws.scene, fileRefs: draws.fileRefs })
    .from(nodes)
    .innerJoin(draws, eq(draws.nodeId, nodes.id))
    .where(and(eq(nodes.id, drawId), eq(nodes.ownerId, share.ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!row) return false;
  if (opts.self && !(await isServed(share, drawId))) return false;
  const placed = drawPlacedFileIds(row.scene, row.fileRefs);
  // An image that is a login's own item keeps the snapshot off every share.
  if ((await loginOwnedIds(share.ownerId, placed)).size > 0) return false;
  if (share.contactId) return true;
  const served = await liveServedIds(share);
  return placed.every((f) => served.has(f.toLowerCase()));
}

/** Per folder path, how many files directly in it are on `served`: the
 *  count a folder link shows beside a subfolder, so a file not served is
 *  not even counted. */
export async function servedFileCounts(
  ownerId: string,
  folderPaths: readonly string[],
  served: readonly string[],
): Promise<Map<string, number>> {
  const ids = served.filter((id) => isUuid(id));
  if (folderPaths.length === 0 || ids.length === 0) return new Map();
  const rows = await db
    .select({ path: sql<string>`${nodes.path}::text`, n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text in (${sql.join(
          folderPaths.map((p) => sql`${p}`),
          sql`, `,
        )})`,
        sql`${nodes.id} = any (${`{${ids.join(',')}}`}::uuid[])`,
      ),
    )
    .groupBy(nodes.path);
  return new Map(rows.map((r) => [r.path, r.n]));
}

async function loadNode(ownerId: string, nodeId: string) {
  const [row] = await db
    .select({ title: nodes.title, data: nodes.data, tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** Resolve the shared node into the shape its presenter renders. Returns null
 *  if the underlying node vanished (deleted after the link was minted). */
export async function loadShareView(share: Share): Promise<ShareView | null> {
  const { ownerId, nodeId, nodeType } = share;
  const served = await liveServedIds(share);
  switch (nodeType) {
    // An open link is read by anyone: a page or note shows only what its
    // link serves (plan 8.1). A mention, a link or a child page card of an
    // item not served says "Private item", and an embed not served is left
    // out (the asset routes refuse those bytes too). A task's or an event's
    // body and a task's checklist are markdown that can name items too, so
    // they take the note rule (T18). A contact share serves what its item
    // names, so it reads the item as it is.
    case 'page': {
      const page = await getPage(ownerId, nodeId);
      if (!page) return null;
      const doc = share.contactId
        ? page.doc
        : ((await servedFilteredDoc(ownerId, served, page.doc)) as typeof page.doc);
      return { kind: 'page', title: page.title, icon: page.icon, width: page.width, doc };
    }
    case 'note': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      const content = typeof d.content === 'string' ? d.content : '';
      return {
        kind: 'note',
        title: n.title,
        content: share.contactId ? content : await servedFilteredNote(ownerId, served, content),
      };
    }
    case 'task': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      const shown = (md: string) =>
        share.contactId ? md : servedFilteredNote(ownerId, served, md);
      const todos = Array.isArray(d.todos)
        ? (d.todos as Array<Record<string, unknown>>).filter(
            (t) => typeof t?.text === 'string' && t.text,
          )
        : [];
      return {
        kind: 'task',
        title: n.title,
        body: await shown(typeof d.body === 'string' ? d.body : ''),
        status: typeof d.status === 'string' ? d.status : 'open',
        priority: typeof d.priority === 'string' ? d.priority : 'normal',
        dueAt: typeof d.due_at === 'string' ? d.due_at : null,
        todos: await Promise.all(
          todos.map(async (t) => ({ text: await shown(t.text as string), done: t.done === true })),
        ),
      };
    }
    case 'event': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      const body = typeof d.body === 'string' ? d.body : '';
      return {
        kind: 'event',
        title: n.title,
        body: share.contactId ? body : await servedFilteredNote(ownerId, served, body),
        startsAt: typeof d.starts_at === 'string' ? d.starts_at : null,
        endsAt: typeof d.ends_at === 'string' ? d.ends_at : null,
        location: typeof d.location === 'string' ? d.location : null,
        // Recurrence + tags travel too — the team/share reader shows the same
        // "nice details" as the owner pane. Reminders stay owner-private.
        recur: typeof d.recur === 'string' ? d.recur : null,
        recurUntil: typeof d.recur_until === 'string' ? d.recur_until : null,
        tags: n.tags ?? [],
      };
    }
    case 'file': {
      const f = await fileById({ ownerId, fileId: nodeId });
      if (!f) return null;
      return {
        kind: 'file',
        fileId: nodeId,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.sizeBytes,
      };
    }
    case 'app': {
      // Only a PUBLISHED app is shareable — never expose a draft build publicly.
      const app = await getApp(ownerId, nodeId);
      if (!app || !app.publishedBuild?.ok) return null;
      return { kind: 'app', appId: nodeId, title: app.title };
    }
    case 'table': {
      // PUBLISHED state only — the draft file is the owner's working copy and
      // never crosses the share boundary (same rule as page drafts).
      const [row] = await db
        .select({
          title: nodes.title,
          data: nodes.data,
          storagePath: tables.storagePath,
          doc: tables.data,
        })
        .from(nodes)
        .leftJoin(tables, eq(tables.nodeId, nodes.id))
        .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
        .limit(1);
      if (!row) return null;
      const d = (row.data ?? {}) as Record<string, unknown>;
      const icon = typeof d.icon === 'string' ? d.icon : null;
      if (row.storagePath) {
        let tabs: NonNullable<Extract<ShareView, { kind: 'table' }>['tabs']>;
        try {
          const abs = resolveStoragePath(row.storagePath);
          tabs = describeWorkbook(abs).map((t) => ({
            id: t.tabId,
            name: t.name,
            rowCount: t.rowCount,
            columns: t.columns.map((c) => ({ id: c.colId, name: c.name, type: c.type })),
            aggregates: t.aggregates,
            // Computed HERE, in SQL over every row, because the reader only
            // ever holds one 200-row window. A client-side sum over a partial
            // page is not a smaller number, it is a wrong one — and wrong
            // silently, which is the failure mode worth paying a query to
            // avoid. `aggregateWindow` returns null for a column it cannot
            // total (a formula column, or a non-numeric asked for a sum), and
            // the footer leaves that cell blank rather than guessing.
            aggregateValues: Object.fromEntries(
              Object.entries(t.aggregates).map(([colId, kind]) => [
                colId,
                aggregateWindow(abs, { columnId: colId, kind, tabId: t.tabId }),
              ]),
            ),
          }));
        } catch {
          // Published file missing/unreadable (e.g. never committed) — treat
          // as vanished rather than leak an error page.
          return null;
        }
        return { kind: 'table', tableId: nodeId, title: row.title, icon, tabs, legacyDoc: null };
      }
      const doc = ensureTableDoc(row.doc ?? emptyTableDoc());
      return {
        kind: 'table',
        tableId: nodeId,
        title: row.title,
        icon,
        tabs: null,
        // A legacy table arrives whole, so the reader computes its own totals
        // with `computeAggregate` and no endpoint is involved. Settings only.
        legacyDoc: { columns: doc.columns, rows: doc.rows, aggregates: doc.aggregates ?? {} },
      };
    }
    case 'formula': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      // Re-validate rather than cast. A spec that no longer parses cannot be
      // rendered OR evaluated, and a public page is the last place to discover
      // that halfway down — treat it as vanished instead.
      const parsed = parseFormulaSpec(d.spec);
      if (!parsed.ok) return null;
      const spec = parsed.spec;
      return {
        kind: 'formula',
        title: n.title,
        spec,
        signature: signatureOf(spec),
        coverageGaps: checkLookupCoverage(spec),
        dimensionIssues: checkDimensions(spec),
      };
    }
    case 'draw': {
      // The share surface renders the COMMITTED snapshot only — the scene
      // JSON and any working draft never cross the share boundary (same rule
      // as page drafts / table draft files).
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const svg = await getDrawSvg(ownerId, nodeId);
      return {
        kind: 'draw',
        title: n.title,
        hasSvg: svg !== null,
        // A raster <image> in the scene vetoes the dark-mode invert filter
        // (one flat filter would show photos as negatives) — same rule the
        // owner previews apply via snapshotPlacesImage().
        hasImage: svg !== null && /<image[\s>]/i.test(svg),
      };
    }
    case 'present': {
      // The canvas runs live from /s/<token>/canvas/frame (latest save); the
      // view names it only, its source never crosses here.
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      return { kind: 'present', presentId: nodeId, title: n.title };
    }
    case 'branch': {
      const folder = await folderById({ ownerId, folderId: nodeId });
      if (!folder) return null;
      return {
        kind: 'folder',
        folderId: nodeId,
        title: folder.slug,
        path: folder.path,
        served: [...served].filter((id) => id !== nodeId.toLowerCase()),
      };
    }
    default:
      return null;
  }
}

/** The shared note's markdown, or null when the node is gone or is not a
 *  note. Read per request, so an edit that drops a reference takes the file
 *  off the link on its next fetch. */
async function loadSharedNote(share: Share): Promise<string | null> {
  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(
      and(eq(nodes.id, share.nodeId), eq(nodes.ownerId, share.ownerId), eq(nodes.type, 'note')),
    )
    .limit(1);
  if (!row) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  return typeof d.content === 'string' ? d.content : '';
}

/** The ids a note's markdown EMBEDS, as `walk` reads a page doc (files:
 *  its pictures and file embeds; drawings; canvases), lower-cased. Parsed into a document
 *  first, as the embed closure does (noteEmbedIds) and as a page's doc is
 *  read: only a rendered picture or embed counts, so an id quoted in a code
 *  block or inline code is not one, and a titled `media:` link is. A link
 *  inside a sentence is a link, not an embed, as on a page. */
function noteEmbeds(content: string, walk: (doc: unknown) => string[]): string[] {
  if (!content) return [];
  return walk(markdownToDoc(content)).map((id) => id.toLowerCase());
}

/** The canvases a page or note share's own content embeds (its page's
 *  committed doc, its note's markdown), lower-case; none for any other
 *  share. Read once per check, however many canvases are asked about. */
async function shareEmbeddedPresents(share: Share): Promise<Set<string>> {
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    return new Set((page ? referencedPresentIds(page.doc) : []).map((d) => d.toLowerCase()));
  }
  if (share.nodeType === 'note') {
    const content = await loadSharedNote(share);
    return new Set(content === null ? [] : noteEmbeds(content, referencedPresentIds));
  }
  return new Set();
}

/** May this share show the snapshot of the canvas `id` (lower-case), one
 *  its content embeds (`embedded`)? Only one the link serves (isServed: the
 *  owner put it on the served list, or a contact share names it), and only
 *  when the canvas has a snapshot. */
async function presentShown(share: Share, embedded: Set<string>, id: string): Promise<boolean> {
  if (!embedded.has(id) || !(await isServed(share, id))) return false;
  const facts = await getPresentEmbedFacts(share.ownerId, id);
  return facts?.posterRev != null;
}

/** May this share show the snapshot of the canvas `presentId`? Only a page
 *  or a note share, only a canvas its own content embeds
 *  (`![Canvas](present:<id>)` in the page's committed doc, never its draft),
 *  only one the link serves, and only when the canvas has a snapshot. Never
 *  the canvas itself: a link shows the picture, no frame and no source. The
 *  /s/:token/present/:presentId route's authorization. */
export async function isEmbeddedPresentAllowed(share: Share, presentId: string): Promise<boolean> {
  if (!isUuid(presentId)) return false;
  const id = presentId.toLowerCase();
  return presentShown(share, await shareEmbeddedPresents(share), id);
}

/** The canvases among `ids` this share shows (isEmbeddedPresentAllowed),
 *  lower-case, the share's content read once: the share page places only
 *  their pictures, the rest as a bare placeholder. */
export async function sharePresentsShown(
  share: Share,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = [...new Set(ids.map((i) => i.toLowerCase()))].filter((i) => isUuid(i));
  if (wanted.length === 0) return out;
  const embedded = await shareEmbeddedPresents(share);
  for (const id of wanted) {
    if (await presentShown(share, embedded, id)) out.add(id);
  }
  return out;
}

/** May this share serve the drawing `drawId` as an embed? Only a page or a
 *  note share, only a drawing its own content embeds (a page's doc, a note's
 *  `draw:` pictures), and only when the drawing and every image its snapshot
 *  carries are served (isDrawServable). So a share never becomes a way to
 *  read arbitrary drawings by id. The /s/:token/draw route serves a drawing
 *  that is itself the shared item; this is the /s/:token/draw/:drawId
 *  route's authorization. */
export async function isEmbeddedDrawAllowed(share: Share, drawId: string): Promise<boolean> {
  if (!isUuid(drawId)) return false;
  const id = drawId.toLowerCase();
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    if (!page || !referencedDrawIds(page.doc).some((d) => d.toLowerCase() === id)) return false;
    return isDrawServable(share, id, { self: true });
  }
  if (share.nodeType === 'note') {
    const content = await loadSharedNote(share);
    if (content === null || !noteEmbeds(content, referencedDrawIds).includes(id)) return false;
    return isDrawServable(share, id, { self: true });
  }
  return false;
}

/** Is `fileId` allowed to be served under this share? A file share serves
 *  itself; a page share serves only the files its doc references that are
 *  served (isServed); a note share only the files its markdown embeds
 *  (`media:` pictures and file embeds, parsed as a page doc is, noteEmbeds)
 *  that are served; an open folder link only a file under the folder's
 *  subtree that is on its list (evaluated per request: a file moved out is
 *  denied on its next fetch; one uploaded later is not on the list). A
 *  contact share serves what its item names. A Present canvas's open link
 *  serves only what canvasMediaServable allows. A login's own item
 *  (nodes.login_id) is served by no share, its own share included
 *  (isServed).
 *  Anything else is denied.
 *  This is the asset route's authorization. */
export async function isAssetAllowed(share: Share, fileId: string): Promise<boolean> {
  if (!isUuid(fileId)) return false;
  if (share.nodeType === 'file') {
    return share.nodeId.toLowerCase() === fileId.toLowerCase() && isServed(share, fileId);
  }
  const id = fileId.toLowerCase();
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    if (!page) return false;
    if (!referencedFileIds(page.doc).some((f) => f.toLowerCase() === id)) return false;
    return isServed(share, id);
  }
  if (share.nodeType === 'note') {
    const content = await loadSharedNote(share);
    if (content === null || !noteEmbeds(content, referencedFileIds).includes(id)) return false;
    if (!(await isFile(share.ownerId, id))) return false;
    return isServed(share, id);
  }
  // A folder is never a contact share (v1, decision 2): refuse outright.
  if (share.nodeType === 'branch' && !share.contactId) {
    if (!(await isFile(share.ownerId, id))) return false;
    return isServed(share, id);
  }
  // A canvas runs on an open link only: a contact share never serves one.
  if (share.nodeType === 'present' && !share.contactId) {
    if ((await loginOwnedIds(share.ownerId, [id])).has(id)) return false;
    return canvasMediaServable(share, id);
  }
  return false;
}

/**
 * May a canvas's open link serve the file `id` (lower case) to its
 * `mantle.media` (task a265178d)? A canvas's media is part of the canvas, as
 * a page's images are part of the page: the link serves it with no switch
 * (owner's ruling, 2026-11-05). Every part checked per request, so any
 * change stops the next fetch:
 *
 *  - the canvas's last save put the file on the link's served list
 *    (`meta.linkAssets`, presents.ts linkServedAssets): it sat in the
 *    canvas's own workspace and the saver may edit it, as a page link
 *    serves only what its opener may edit (task 71285cd1, M1). Fixed at
 *    the save, so a later move never wakes a file the save did not list
 *    (M2); it is a file, not a read-only snapshot copy;
 *  - the file still sits in the canvas's own workspace (decision 7: a
 *    member's canvas never hands out an Admin file on an anonymous link),
 *    and the canvas still sits in the one the list was made in
 *    (`meta.linkHome`), so a move of either stops it;
 *  - it is a type a canvas plays or shows (CANVAS_MEDIA_MIMES) and within
 *    CANVAS_MEDIA_MAX_BYTES: the link is a canvas's media, never a way to
 *    hand out a document by its id, nor a large read per request.
 *
 * The route answers every no with the same 404, before it reads any bytes.
 */
async function canvasMediaServable(share: Share, id: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select (${itemHomeSql('f')} is not distinct from ${itemHomeSql('c')}) as same_ws,
           (f.data->>'size_bytes' is not null) as sized
      from presents p
      join nodes c on c.id = p.node_id
      join nodes f on f.id = ${id}::uuid
     where p.node_id = ${share.nodeId}::uuid
       and c.owner_id = ${share.ownerId}::uuid
       and c.type = 'present'
       and f.owner_id = ${share.ownerId}::uuid
       and f.type = 'file'
       and not coalesce(f.data ? 'snapshot_of', false)
       and coalesce(p.meta->'linkAssets', '[]'::jsonb) @> jsonb_build_array(${id}::text)
       and (p.meta->>'linkHome') is not distinct from ${itemHomeSql('c')}::text
     limit 1
  `)) as unknown as { same_ws: boolean; sized: boolean }[];
  // A row with no stored size is not served: the cap below reads it.
  if (rows[0]?.same_ws !== true || rows[0]?.sized !== true) return false;
  const file = await fileById({ ownerId: share.ownerId, fileId: id });
  return !!file && !!canvasMediaMime(file.mimeType) && file.sizeBytes <= CANVAS_MEDIA_MAX_BYTES;
}

/** Whether `id` is one of the owner's files. */
async function isFile(ownerId: string, id: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'file')))
    .limit(1);
  return !!hit;
}
