/**
 * Web-side share helpers. Re-exports the owner-side CRUD from @mantle/content
 * and adds the PUBLIC read path: resolve a token → the data a presenter needs,
 * and the asset-scoping check the public file route enforces. None of this
 * calls requireOwner — the public surface trusts a resolved active token and
 * only ever reaches the one shared node (+ its referenced files).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { asViewerLevel, db, draws, nodes, tables, type Share, type ViewerLevel } from '@mantle/db';
import {
  drawPlacedFileIds,
  getPage,
  getApp,
  getDrawSvg,
  referencedDrawIds,
  referencedFileIds,
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
import { markdownRefs } from '@mantle/content-core/markdown-refs';
import { isUuid } from '@mantle/std';
import { fileById, folderById } from '@/lib/files';

export {
  createShare,
  revokeShare,
  revokeShareTree,
  applyShareMode,
  getActiveShareForNode,
  resolveActiveShareByToken,
  resolveActiveShareRowByToken,
  recordShareView,
  isShareable,
  type ShareSummary,
} from '@mantle/content';

export function buildShareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/s/${token}`;
}

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
      /** The item levels this link shows (linkLevels): never sent to the
       *  visitor, it filters the listing and the asset route. */
      levels: ViewerLevel[];
    }
  // Only WHETHER a committed snapshot exists (false when the last commit
  // carried none; the presenter shows a placeholder rather than 404ing a link
  // that was legitimately minted). The bytes are served separately, as an
  // image, by /s/<token>/draw.
  | { kind: 'draw'; title: string; hasSvg: boolean; hasImage?: boolean };

/**
 * The item levels a folder's or a page's open link shows: its contents, a
 * page's embeds, a drawing link's images. Every link is public (client
 * logins C3: the old client links are retired, migration 0192, and the
 * public read path never serves a link on a client item), so a link shows
 * public items only. A file uploaded later into a folder lands at admin (no
 * inheritance), so it stays out until someone lowers it; an embed follows
 * its page down when the page is lowered (embedding means sharing), so it
 * is served unless an admin raised it again on purpose. The shared item
 * itself is not filtered: the item IS the link. The parameter stays so the
 * callers keep their shape.
 */
export function linkLevels(_folderAudience: string): ViewerLevel[] {
  return ['public'];
}

/** Every level: what a CONTACT share's embeds may sit at. */
const ANY_LEVEL: ViewerLevel[] = ['admin', 'team', 'client', 'public'];

/**
 * The levels a share serves its embeds at. An open link: `linkLevels`
 * (public only). A CONTACT share (migration 0214) lowers nothing, so an
 * admin page's images stay admin; it serves what the shared item itself
 * embeds whatever its level, read only, and only while the share lives
 * (the same idea as "embeds follow their embedder" for folder shares,
 * migration 0208, with no column). Every caller still checks the embed is
 * named by the shared item's own content (its embed closure).
 */
export function shareLevels(share: Pick<Share, 'contactId'>, audience: string): ViewerLevel[] {
  return share.contactId ? ANY_LEVEL : linkLevels(audience);
}

/** Whether every one of `ids` (the owner's items that still exist) sits at
 *  `levels`. An id with no row is not a reason to refuse: the byte route
 *  404s it on its own. */
async function allAtLevels(
  ownerId: string,
  ids: readonly string[],
  levels: readonly ViewerLevel[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  const [hit] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        inArray(nodes.id, [...ids]),
        sql`${nodes.audience} not in (${levelList(levels)})`,
      ),
    )
    .limit(1);
  return !hit;
}

/**
 * May a link at `levels` show this drawing's snapshot? The snapshot carries
 * every image the committed scene places, so one image above the link's
 * levels (an admin raised it on purpose) keeps the whole snapshot off the
 * link: there is no serving it without that image. `self`: the drawing is an
 * EMBED (in a shared page), so its own level counts too; a drawing that is
 * itself the shared item is the link and is not filtered.
 */
export async function isDrawServable(
  ownerId: string,
  drawId: string,
  levels: readonly ViewerLevel[],
  opts: { self: boolean },
): Promise<boolean> {
  const [row] = await db
    .select({ audience: nodes.audience, scene: draws.scene, fileRefs: draws.fileRefs })
    .from(nodes)
    .innerJoin(draws, eq(draws.nodeId, nodes.id))
    .where(and(eq(nodes.id, drawId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!row) return false;
  if (opts.self && !levels.includes(asViewerLevel(row.audience))) return false;
  return allAtLevels(ownerId, drawPlacedFileIds(row.scene, row.fileRefs), levels);
}

/** SQL list of `levels`, for an IN / NOT IN. */
function levelList(levels: readonly ViewerLevel[]) {
  return sql.join(
    levels.map((l) => sql`${l}`),
    sql`, `,
  );
}

/**
 * Is there a folder strictly between the shared folder `rootPath` and
 * `path` (inclusive of `path` itself when it is a folder, and of a file's
 * own folder, since a file's path IS its folder's) that sits above the
 * link's levels? Such a folder is not listed, so nothing under it is
 * reachable through the link either, even an item at a low enough level.
 */
export async function hiddenFolderBetween(
  ownerId: string,
  rootPath: string,
  path: string,
  levels: readonly ViewerLevel[],
): Promise<boolean> {
  const [hit] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path} @> ${path}::ltree`,
        sql`${nodes.path} <@ ${rootPath}::ltree`,
        sql`${nodes.path} <> ${rootPath}::ltree`,
        sql`${nodes.audience} not in (${levelList(levels)})`,
      ),
    )
    .limit(1);
  return !!hit;
}

/** Per folder path, how many files directly in it sit at `levels`: the
 *  count a folder link shows beside a subfolder, so hidden files are not
 *  even counted. */
export async function visibleFileCounts(
  ownerId: string,
  folderPaths: readonly string[],
  levels: readonly ViewerLevel[],
): Promise<Map<string, number>> {
  if (folderPaths.length === 0) return new Map();
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
        inArray(nodes.audience, [...levels]),
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
  switch (nodeType) {
    case 'page': {
      const page = await getPage(ownerId, nodeId);
      if (!page) return null;
      return { kind: 'page', title: page.title, icon: page.icon, width: page.width, doc: page.doc };
    }
    case 'note': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      return {
        kind: 'note',
        title: n.title,
        content: typeof d.content === 'string' ? d.content : '',
      };
    }
    case 'task': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      return {
        kind: 'task',
        title: n.title,
        body: typeof d.body === 'string' ? d.body : '',
        status: typeof d.status === 'string' ? d.status : 'open',
        priority: typeof d.priority === 'string' ? d.priority : 'normal',
        dueAt: typeof d.due_at === 'string' ? d.due_at : null,
        todos: Array.isArray(d.todos)
          ? (d.todos as Array<Record<string, unknown>>)
              .filter((t) => typeof t?.text === 'string' && t.text)
              .map((t) => ({ text: t.text as string, done: t.done === true }))
          : [],
      };
    }
    case 'event': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      return {
        kind: 'event',
        title: n.title,
        body: typeof d.body === 'string' ? d.body : '',
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
        levels: linkLevels(folder.audience),
      };
    }
    default:
      return null;
  }
}

/** The shared note's markdown and level, or null when the node is gone or
 *  is not a note. Read per request, so an edit that drops a reference takes
 *  the file off the link on its next fetch. */
async function loadSharedNote(share: Share): Promise<{ content: string; audience: string } | null> {
  const [row] = await db
    .select({ data: nodes.data, audience: nodes.audience })
    .from(nodes)
    .where(
      and(eq(nodes.id, share.nodeId), eq(nodes.ownerId, share.ownerId), eq(nodes.type, 'note')),
    )
    .limit(1);
  if (!row) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  return { content: typeof d.content === 'string' ? d.content : '', audience: row.audience };
}

/** The ids a note's own markdown names with `scheme` (`media:` files,
 *  `draw:` drawings), lower-cased. markdownRefs is the one parser for these
 *  schemes; an id that is not a uuid is dropped, so it never reaches a
 *  query (Postgres would answer 22P02, an opaque 500). */
function noteRefIds(content: string, scheme: 'media' | 'draw'): string[] {
  return markdownRefs(content)
    .filter((r) => r.scheme === scheme && isUuid(r.id))
    .map((r) => r.id.toLowerCase());
}

/** May this share serve the drawing `drawId` as an embed? Only a page or a
 *  note share, only a drawing its own content names (a page's doc, a note's
 *  `draw:` refs), and only when the drawing and every image its snapshot
 *  carries sit at the share's levels (shareLevels, as for files). So a share
 *  never becomes a way to read arbitrary drawings by id. The /s/:token/draw
 *  route serves a drawing that is itself the shared item; this is the
 *  /s/:token/draw/:drawId route's authorization. */
export async function isEmbeddedDrawAllowed(share: Share, drawId: string): Promise<boolean> {
  if (!isUuid(drawId)) return false;
  const id = drawId.toLowerCase();
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    if (!page || !referencedDrawIds(page.doc).includes(drawId)) return false;
    return isDrawServable(share.ownerId, drawId, shareLevels(share, page.audience), {
      self: true,
    });
  }
  if (share.nodeType === 'note') {
    const note = await loadSharedNote(share);
    if (!note || !noteRefIds(note.content, 'draw').includes(id)) return false;
    return isDrawServable(share.ownerId, id, shareLevels(share, note.audience), { self: true });
  }
  return false;
}

/** Is `fileId` allowed to be served under this share? A file share serves
 *  itself; a page share serves only the files its doc references that sit
 *  at the link's levels (an embed an admin raised above the page is not
 *  served; linkLevels); a note share serves only the files its own markdown
 *  names (`media:` pictures and file links, markdownRefs), under the same
 *  level rule (shareLevels); a folder
 *  share serves the files under the folder's subtree (recursive, evaluated
 *  per request: a file moved out is denied on its next fetch) that sit at
 *  the link's levels, under no folder above them (linkLevels, audit F19): a
 *  file uploaded into a public folder stays admin and is not served. Anything
 *  else is denied. This is the asset route's authorization. */
export async function isAssetAllowed(share: Share, fileId: string): Promise<boolean> {
  if (share.nodeType === 'file') return share.nodeId === fileId;
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    if (!page) return false;
    if (!referencedFileIds(page.doc).includes(fileId)) return false;
    const [hit] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, fileId),
          eq(nodes.ownerId, share.ownerId),
          inArray(nodes.audience, shareLevels(share, page.audience)),
        ),
      )
      .limit(1);
    return !!hit;
  }
  if (share.nodeType === 'note') {
    if (!isUuid(fileId)) return false;
    const note = await loadSharedNote(share);
    if (!note || !noteRefIds(note.content, 'media').includes(fileId.toLowerCase())) return false;
    const [hit] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, fileId),
          eq(nodes.ownerId, share.ownerId),
          eq(nodes.type, 'file'),
          inArray(nodes.audience, shareLevels(share, note.audience)),
        ),
      )
      .limit(1);
    return !!hit;
  }
  // A folder is never a contact share (v1, decision 2): refuse outright.
  if (share.nodeType === 'branch' && !share.contactId) {
    // Hot path (one call per file/download under a folder share): fetch only
    // the folder's path — folderById would also run two folderCounts queries
    // whose results this check never reads.
    const [folder] = await db
      .select({ path: nodes.path, audience: nodes.audience })
      .from(nodes)
      .where(
        and(eq(nodes.id, share.nodeId), eq(nodes.ownerId, share.ownerId), eq(nodes.type, 'branch')),
      )
      .limit(1);
    if (!folder?.path) return false;
    const levels = linkLevels(folder.audience);
    const [hit] = await db
      .select({ path: nodes.path })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, fileId),
          eq(nodes.ownerId, share.ownerId),
          eq(nodes.type, 'file'),
          sql`${nodes.path} <@ ${folder.path}::ltree`,
          inArray(nodes.audience, levels),
        ),
      )
      .limit(1);
    if (!hit) return false;
    return !(await hiddenFolderBetween(share.ownerId, folder.path, hit.path, levels));
  }
  return false;
}
