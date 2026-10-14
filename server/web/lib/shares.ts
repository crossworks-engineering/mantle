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
 * contact share holds no list: it serves what its item names. No level is
 * read: the rule is the list, checked here on the system pool per request.
 */
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, draws, nodes, tables, type Share } from '@mantle/db';
import {
  drawPlacedFileIds,
  getPage,
  getApp,
  getDrawSvg,
  referencedDrawIds,
  referencedFileIds,
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

/** The ids among `ids` that are the owner's read-only snapshot copies (W6b),
 *  lower-case. */
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
 *  served, whatever a list made before the rule holds (W6b fix round 3,
 *  L-1). */
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
  if (id === share.nodeId.toLowerCase()) return true;
  // A read-only snapshot copy stays in its private workspace: no link and
  // no contact share serves it (W6b fix round 3, L-1).
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
  if (share.contactId) return true;
  const served = await liveServedIds(share);
  return drawPlacedFileIds(row.scene, row.fileRefs).every((f) => served.has(f.toLowerCase()));
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

/** The ids a note's markdown EMBEDS as `kind` (files: its pictures and
 *  file embeds; draws: its drawings), lower-cased. Parsed into a document
 *  first, as the embed closure does (noteEmbedIds) and as a page's doc is
 *  read: only a rendered picture or embed counts, so an id quoted in a code
 *  block or inline code is not one, and a titled `media:` link is. A link
 *  inside a sentence is a link, not an embed, as on a page. */
function noteEmbeds(content: string, kind: 'file' | 'draw'): string[] {
  if (!content) return [];
  const doc = markdownToDoc(content);
  return (kind === 'file' ? referencedFileIds(doc) : referencedDrawIds(doc)).map((id) =>
    id.toLowerCase(),
  );
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
    if (content === null || !noteEmbeds(content, 'draw').includes(id)) return false;
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
 *  contact share serves what its item names. Anything else is denied. This
 *  is the asset route's authorization. */
export async function isAssetAllowed(share: Share, fileId: string): Promise<boolean> {
  if (share.nodeType === 'file') return share.nodeId === fileId;
  if (!isUuid(fileId)) return false;
  const id = fileId.toLowerCase();
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    if (!page) return false;
    if (!referencedFileIds(page.doc).some((f) => f.toLowerCase() === id)) return false;
    return isServed(share, id);
  }
  if (share.nodeType === 'note') {
    const content = await loadSharedNote(share);
    if (content === null || !noteEmbeds(content, 'file').includes(id)) return false;
    if (!(await isFile(share.ownerId, id))) return false;
    return isServed(share, id);
  }
  // A folder is never a contact share (v1, decision 2): refuse outright.
  if (share.nodeType === 'branch' && !share.contactId) {
    if (!(await isFile(share.ownerId, id))) return false;
    return isServed(share, id);
  }
  return false;
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
