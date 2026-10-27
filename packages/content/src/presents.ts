/**
 * Presents surface (the Present workspace, docs/proposals/canvas-files.md).
 * A present is a `nodes` row with type='present' plus a `presents` sidecar
 * row holding the canvas:
 *
 *   nodes.title             display name (follows the canvas <title>)
 *   nodes.data.summary      extractor-written summary
 *   presents.source         the canvas, one whole HTML document (the truth)
 *   presents.source_text    derived text (search and the extractor read it)
 *   presents.meta           size, theme and libraries read off the head
 *   presents.css            Tailwind utilities compiled from the source
 *   presents.poster_png     a cached picture of the canvas, never the source
 *
 * All under the `present` ltree root, lazy-created on first write, in the
 * shared row-only kind folders like Draw. Unlike Draw there is no draft and
 * no commit: a save is live at once, everywhere (latest is latest). `rev` is
 * the optimistic-concurrency etag that keeps two writers apart, not a review
 * step.
 *
 * Indexing (section 4.3): an agent may save a canvas ten times in a minute,
 * and one extractor pass per save would be ten model calls for one canvas.
 * So a save never announces itself: when its text changed it sets
 * `index_due_at` a quiet period ahead (each later save pushes it on), and
 * flushDuePresentIndex, on the agent runtime's timer, re-indexes the item
 * once that period passes. A save whose text is unchanged (a colour, a
 * layout) costs nothing.
 *
 * Every save (createPresent, savePresentSource; present_create,
 * present_update, present_restore and the HTTP routes all reach one) runs
 * the source through honestCanvasSource (./drawing-seal.ts): a diagram
 * canvas's image check marks are kept only as circuit_trace sealed them,
 * and its counts are its own marks'.
 */
import { and, asc, desc, eq, gt, ilike, isNotNull, lte, notInArray, or, sql } from 'drizzle-orm';
import {
  db,
  nodes,
  presents,
  presentRevisions,
  changedFields,
  markContentChanged,
  type Node,
  type PresentMeta,
  assertItemRight,
  headsOrSpace,
  isSnapshotCopy,
  withDeadlockRetry,
  withNodeDeleteHeads,
  withNodeInsertHeads,
} from '@mantle/db';
import { canvasImports, canvasText, parseCanvasHead } from '@mantle/content-core/canvas';
import { InputError } from '@mantle/std';
import { claimsPidTemplate } from '@mantle/diagram-templates';
import { assertCanvasSize, storedCanvasSource } from './drawing-seal';
import { asKindRootRepair } from './kind-root';
import { dedupeTags } from './tags';

export const PRESENTS_ROOT_LABEL = 'present';

/** How long a canvas must go without a text change before it is re-indexed
 *  (section 4.3). */
export const PRESENT_INDEX_QUIET_MS = 5 * 60_000;

/** How many past sources a canvas keeps (decision 4). */
export const PRESENT_REVISIONS_KEPT = 10;

/** A canvas new items start from when the caller sends none. */
export const EMPTY_CANVAS = `<!doctype html>
<html>
  <head>
    <title>Untitled canvas</title>
    <meta name="canvas:size" content="1600x900" />
  </head>
  <body class="flex items-center justify-center">
    <p class="text-2xl text-muted-foreground">Ask Presenter to draw something here.</p>
  </body>
</html>
`;

export type PresentRow = {
  id: string;
  title: string;
  /** Emoji beside the title, as pages and draws; null = the kind's glyph. */
  icon: string | null;
  tags: string[];
  /** The canvas's own description (`<meta name="description">`). */
  description: string | null;
  /** Extractor-written summary. */
  summary: string | null;
  meta: PresentMeta;
  rev: number;
  /** Whether a poster is cached for the current rev (the save's own render). */
  hasPoster: boolean;
  /** A read-only snapshot copy of an accepted item (as draws). */
  readOnly?: true;
  createdAt: string;
  updatedAt: string;
};

export type PresentDetail = PresentRow & {
  /** The canvas source (the Source view shows it read-only). */
  source: string;
};

const DEFAULT_META: PresentMeta = {
  size: { w: 1600, h: 900 },
  theme: 'follow',
  libs: [],
  scripts: [],
  posterAt: null,
};

function metaOf(raw: unknown): PresentMeta {
  if (!raw || typeof raw !== 'object') return DEFAULT_META;
  return { ...DEFAULT_META, ...(raw as Partial<PresentMeta>) };
}

function rowOf(
  n: Node,
  p: { meta: unknown; rev: number | null; posterRev: number | null } | null,
): PresentRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const rev = p?.rev ?? 1;
  return {
    id: n.id,
    title: n.title,
    icon: typeof d.icon === 'string' && d.icon ? d.icon : null,
    tags: n.tags ?? [],
    description: typeof d.description === 'string' && d.description ? d.description : null,
    summary: typeof d.summary === 'string' ? d.summary : null,
    meta: metaOf(p?.meta),
    rev,
    hasPoster: p?.posterRev != null && p.posterRev === rev,
    ...(isSnapshotCopy(n) ? { readOnly: true as const } : {}),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

/** What a save reads off a canvas, without running it. Refuses a source
 *  over the size limit (./drawing-seal.ts assertCanvasSize). */
export function readCanvas(source: string): {
  title: string;
  description: string;
  text: string;
  meta: PresentMeta;
} {
  assertCanvasSize(source);
  const head = parseCanvasHead(source);
  const { modules, scripts } = canvasImports(source);
  return {
    title: head.title,
    description: head.description,
    text: canvasText(source),
    meta: {
      size: head.size,
      theme: head.theme,
      libs: modules,
      scripts,
      posterAt: head.posterAt,
    },
  };
}

/** The kind's root folder, made as system(repair:kind-root) (kind-root.ts). */
async function ensureRoot(ownerId: string): Promise<void> {
  await asKindRootRepair(() =>
    headsOrSpace(
      (f) =>
        withDeadlockRetry(() =>
          withNodeInsertHeads(ownerId, [{ type: 'branch', path: PRESENTS_ROOT_LABEL }], f),
        ),
      (tx) =>
        tx
          .insert(nodes)
          .values({
            ownerId,
            type: 'branch',
            title: 'Present',
            slug: PRESENTS_ROOT_LABEL,
            path: PRESENTS_ROOT_LABEL,
            data: {
              description: 'Canvases: agent-written diagrams, animations and decks.',
            },
          })
          .onConflictDoNothing({
            target: [nodes.ownerId, nodes.path],
            where: sql`${nodes.type} = 'branch'`,
          }),
    ),
  );
}

export type PresentSort = 'edited' | 'newest' | 'oldest' | 'title';

type ListPresentsOpts = { query?: string; tag?: string; sort?: PresentSort };

function presentOrderBy(sort?: PresentSort) {
  switch (sort) {
    case 'newest':
      return desc(nodes.createdAt);
    case 'oldest':
      return asc(nodes.createdAt);
    case 'title':
      return asc(nodes.title);
    case 'edited':
    default:
      return desc(nodes.updatedAt);
  }
}

function presentConds(ownerId: string, opts: ListPresentsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${presents.sourceText} ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

/** The columns a row reads (a function: the schema is read at call time). */
const rowColumns = () => ({
  node: nodes,
  meta: presents.meta,
  rev: presents.rev,
  posterRev: presents.posterRev,
});

export async function listPresents(
  ownerId: string,
  opts: ListPresentsOpts & { limit?: number; offset?: number } = {},
): Promise<PresentRow[]> {
  const rows = await db
    .select(rowColumns())
    .from(nodes)
    .leftJoin(presents, eq(presents.nodeId, nodes.id))
    .where(and(...presentConds(ownerId, opts)))
    .orderBy(presentOrderBy(opts.sort))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map((r) => rowOf(r.node, r));
}

export async function countPresents(ownerId: string, opts: ListPresentsOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .leftJoin(presents, eq(presents.nodeId, nodes.id))
    .where(and(...presentConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function getPresent(ownerId: string, id: string): Promise<PresentDetail | null> {
  const [row] = await db
    .select({ ...rowColumns(), source: presents.source })
    .from(nodes)
    .leftJoin(presents, eq(presents.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!row) return null;
  return { ...rowOf(row.node, row), source: row.source ?? '' };
}

/** What the frame route serves: the source, its compiled CSS and the head
 *  facts the fit needs. Null when there is no such canvas. */
export async function getPresentFrame(
  ownerId: string,
  id: string,
): Promise<{ source: string; css: string; meta: PresentMeta; rev: number } | null> {
  const [row] = await db
    .select({ source: presents.source, css: presents.css, meta: presents.meta, rev: presents.rev })
    .from(presents)
    .innerJoin(nodes, eq(nodes.id, presents.nodeId))
    .where(and(eq(presents.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!row) return null;
  return { source: row.source, css: row.css, meta: metaOf(row.meta), rev: row.rev };
}

/** A canvas's Tailwind utilities: the caller compiles (the compiler is a
 *  build-tier package), from the source as the save stores it. A function
 *  is called with that source once the save's checks and the caller's
 *  right have passed (savePresentSource: after assertItemRight;
 *  createPresent: in its transaction, after the node's insert, the
 *  database's check of the right to create there), so a compile never
 *  runs for a source no one may store and never reads one the save
 *  rewrites. */
export type CanvasCss = string | ((stored: string) => Promise<string>);
const cssFor = (css: CanvasCss | undefined, stored: string): Promise<string> =>
  typeof css === 'function' ? css(stored) : Promise.resolve(css ?? '');

export type CreatePresentInput = {
  /** The canvas; EMPTY_CANVAS when absent. */
  source?: string;
  /** Tailwind utilities compiled from the stored source (CanvasCss). */
  css?: CanvasCss;
  /** Display name; the canvas <title> when absent. */
  title?: string;
  tags?: string[];
};

type PresentTx = Pick<typeof db, 'insert' | 'delete'>;

/** Record `source` as revision `rev` and drop all but the newest kept. */
async function recordRevision(tx: PresentTx, id: string, rev: number, source: string) {
  await tx
    .insert(presentRevisions)
    .values({ nodeId: id, rev, source })
    .onConflictDoUpdate({
      target: [presentRevisions.nodeId, presentRevisions.rev],
      set: { source, createdAt: new Date() },
    });
  await tx
    .delete(presentRevisions)
    .where(
      and(eq(presentRevisions.nodeId, id), lte(presentRevisions.rev, rev - PRESENT_REVISIONS_KEPT)),
    );
}

export async function createPresent(
  ownerId: string,
  input: CreatePresentInput,
): Promise<PresentDetail> {
  // Every save stores a diagram canvas's image checks as circuit_trace
  // sealed them, and their counts as its marks hold (./drawing-seal.ts):
  // whoever wrote the source, by whichever path.
  const source = storedCanvasSource(input.source ?? EMPTY_CANVAS);
  const read = readCanvas(source);
  await ensureRoot(ownerId);
  const title = (input.title ?? '').trim().slice(0, 200) || read.title || 'Untitled canvas';

  // Heads first (workspaces plan U1): the folder the canvas lands in. A new
  // item is indexed by the extractor's drain and sweep, as a new drawing is;
  // only later text changes wait for the quiet period.
  return headsOrSpace<PresentDetail>(
    (f) =>
      withDeadlockRetry(() =>
        withNodeInsertHeads(ownerId, [{ type: 'present', path: PRESENTS_ROOT_LABEL }], f),
      ),
    async (tx) => {
      const [node] = await tx
        .insert(nodes)
        .values({
          ownerId,
          type: 'present',
          title,
          path: PRESENTS_ROOT_LABEL,
          data: read.description ? { description: read.description } : {},
          tags: dedupeTags(input.tags ?? []),
        })
        .returning();
      if (!node) throw new Error('createPresent: insert returned no row');
      // The CSS once the node is in: its insert is the caller's right to
      // create here (the database's row check), so a compile never runs
      // for a canvas no one may store (as savePresentSource compiles after
      // assertItemRight).
      const css = await cssFor(input.css, source);
      await tx.insert(presents).values({
        nodeId: node.id,
        source,
        sourceText: read.text,
        meta: read.meta,
        css,
        rev: 1,
      });
      await recordRevision(tx, node.id, 1, source);
      return {
        ...rowOf(node, { meta: read.meta, rev: 1, posterRev: null }),
        source,
      };
    },
  );
}

export type SavePresentResult =
  | { ok: true; present: PresentDetail }
  | { ok: false; conflict: true; rev: number }
  | { ok: false; missing: true };

/**
 * Replace a canvas's source: live at once (no draft). `ifRev`, when given,
 * must equal the stored rev, or nothing is written and the current rev comes
 * back (two writers never overwrite each other blind). The title follows the
 * canvas <title> when the head names one. Re-indexing waits for the quiet
 * period (see the header); a rename re-embeds at once (one local embedding).
 */
export async function savePresentSource(
  ownerId: string,
  id: string,
  given: { source: string; css: CanvasCss; ifRev?: number },
): Promise<SavePresentResult> {
  // The size first (cheap), then the row and the caller's right, and only
  // then the checks that read the source: no one without the right to
  // edit the canvas makes the server read a source.
  assertCanvasSize(given.source);
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!node) return { ok: false, missing: true };
  // The caller's right first: a scope that reads the canvas and may not edit
  // it gets the refusal, not a conflict.
  await assertItemRight(id, 'edit');
  // As createPresent: the image checks as sealed, the counts as held.
  const stored = storedCanvasSource(given.source);
  const input = { ...given, source: stored, css: await cssFor(given.css, stored) };
  const read = readCanvas(input.source);

  return db.transaction(async (tx) => {
    // The node as it is now, locked: a rename or a tag change since the read
    // above is kept, not written back over.
    const [fresh] = await tx.select().from(nodes).where(eq(nodes.id, id)).for('update').limit(1);
    if (!fresh) return { ok: false as const, missing: true as const };
    const locked = await tx
      .select({ rev: presents.rev, sourceText: presents.sourceText, source: presents.source })
      .from(presents)
      .where(eq(presents.nodeId, id))
      .for('update')
      .limit(1);
    const cur = locked[0];
    if (!cur) return { ok: false as const, missing: true as const };
    if (input.ifRev !== undefined && input.ifRev !== cur.rev) {
      return { ok: false as const, conflict: true as const, rev: cur.rev };
    }
    const sourceChanged = cur.source !== input.source;
    const rev = sourceChanged ? cur.rev + 1 : cur.rev;
    const textChanged = cur.sourceText !== read.text;
    // The title follows the canvas <title> only when the <title> changed: a
    // name given by hand (updatePresent) is kept through saves that leave
    // the head's title as it was.
    const headTitleChanged = read.title !== readCanvas(cur.source).title;
    const title = headTitleChanged && read.title ? read.title : fresh.title;
    const data: Record<string, unknown> = { ...((fresh.data ?? {}) as Record<string, unknown>) };
    if (read.description) data.description = read.description;
    else delete data.description;

    const [updated] = await tx
      .update(nodes)
      .set({ title, data, updatedAt: new Date() })
      .where(eq(nodes.id, id))
      .returning();
    if (!updated) throw new Error('savePresentSource: update returned no row');
    // A new title re-embeds now (the kind registry's `indexed`). The text
    // waits for the quiet period: never one extractor pass per save.
    const row =
      (await markContentChanged(
        tx,
        { id, type: 'present' },
        changedFields({ title: [fresh.title, title] }),
      )) ?? updated;
    await tx
      .update(presents)
      .set({
        source: input.source,
        sourceText: read.text,
        meta: read.meta,
        css: input.css,
        rev,
        ...(textChanged ? { indexDueAt: new Date(Date.now() + PRESENT_INDEX_QUIET_MS) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(presents.nodeId, id));
    if (sourceChanged) await recordRevision(tx, id, rev, input.source);
    return {
      ok: true as const,
      present: { ...rowOf(row, { meta: read.meta, rev, posterRev: null }), source: input.source },
    };
  });
}

/** What a maintenance re-save did with one canvas (resavePidCanvas). */
export type PidResaveOutcome =
  /** The save's checks wrote it differently: stored (or, in a dry run,
   *  would be). */
  | 'changed'
  /** The save's checks write it as it is: nothing to do. */
  | 'unchanged'
  /** A save would refuse it now (not exactly what buildCanvas writes, its
   *  data past a limit): left as it is (the runtime trusts none of its
   *  marks). */
  | 'refused'
  /** Saved by someone while the run read it: left for the next run. */
  | 'moved';

/** One canvas's re-save: what happened to its source, and whether its
 *  poster (the cached picture a Page embed shows) was cleared, or in a dry
 *  run would be. */
export type PidResave = { outcome: PidResaveOutcome; poster: boolean };

/**
 * The `pid` canvases of the box (any owner), a page at a time by id: a
 * canvas whose source claims the template (claimsPidTemplate; the SQL
 * only narrows to sources that name `pid` at all). For the maintenance
 * re-save (server/web lib/maintenance/pid-canvas-resave.ts).
 */
export async function listPidCanvasPage(
  after: string | null,
  limit: number,
): Promise<{ ids: string[]; next: string | null }> {
  const rows = await db
    .select({ id: presents.nodeId, source: presents.source })
    .from(presents)
    .where(and(ilike(presents.source, '%pid%'), ...(after ? [gt(presents.nodeId, after)] : [])))
    .orderBy(asc(presents.nodeId))
    .limit(limit);
  return {
    ids: rows.filter((r) => claimsPidTemplate(r.source)).map((r) => r.id),
    next: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

/**
 * One `pid` canvas written again through the checks every save runs
 * (storedCanvasSource): its marks as circuit_trace sealed them, no trust
 * word typed into a label, its counts its own. For a canvas saved before
 * those checks shipped, so it shows what a save would store. The
 * maintenance runner's write (pid-canvas-resave), with no caller's right
 * to check (the box's operator runs it) and nothing announced: the title
 * and the node are not touched, no re-index is scheduled and no extractor
 * pass runs (the stored text catches up in the index at the canvas's next
 * edit). Its own revision, as a save's, so the old source stays in the
 * canvas's history. Its poster is cleared too, whatever the outcome but
 * `moved`: it was drawn by the runtime before these checks, in its words
 * and colours (a typed claim in a label, a mark no seal holds), and a Page
 * embed shows "no snapshot yet" until the canvas's next look draws a new
 * one (nothing re-renders here). `apply` false: what would happen,
 * nothing written.
 */
export async function resavePidCanvas(id: string, opts: { apply: boolean }): Promise<PidResave> {
  const [row] = await db
    .select({ source: presents.source, poster: sql<boolean>`${presents.posterPng} is not null` })
    .from(presents)
    .where(eq(presents.nodeId, id))
    .limit(1);
  if (!row) return { outcome: 'moved', poster: false };
  let next: string | null;
  let outcome: PidResaveOutcome;
  try {
    next = storedCanvasSource(row.source);
    outcome = next === row.source ? 'unchanged' : 'changed';
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    next = null;
    outcome = 'refused';
  }
  if (!opts.apply) return { outcome, poster: row.poster };
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select({
        rev: presents.rev,
        source: presents.source,
        poster: sql<boolean>`${presents.posterPng} is not null`,
      })
      .from(presents)
      .where(eq(presents.nodeId, id))
      .for('update')
      .limit(1);
    if (!cur || cur.source !== row.source) return { outcome: 'moved' as const, poster: false };
    const unposter = { posterPng: null, posterRev: null };
    if (outcome !== 'changed' || next === null) {
      if (!cur.poster) return { outcome, poster: false };
      await tx.update(presents).set(unposter).where(eq(presents.nodeId, id));
      return { outcome, poster: true };
    }
    const read = readCanvas(next);
    const rev = cur.rev + 1;
    await tx
      .update(presents)
      .set({
        source: next,
        sourceText: read.text,
        meta: read.meta,
        rev,
        ...unposter,
        updatedAt: new Date(),
      })
      .where(eq(presents.nodeId, id));
    await recordRevision(tx, id, rev, next);
    return { outcome, poster: cur.poster };
  });
}

export type UpdatePresentInput = {
  title?: string;
  tags?: string[];
  /** Emoji beside the title; `''` clears it. */
  icon?: string;
};

/** Metadata only (title, tags, icon), saved live like a drawing's. The
 *  source changes through savePresentSource. */
export async function updatePresent(
  ownerId: string,
  id: string,
  input: UpdatePresentInput,
): Promise<PresentRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!node) return null;
  const data: Record<string, unknown> = { ...((node.data ?? {}) as Record<string, unknown>) };
  if (input.icon !== undefined) data.icon = input.icon;
  const title =
    input.title !== undefined ? input.title.trim().slice(0, 200) || 'Untitled canvas' : node.title;
  const changed = changedFields({ title: [node.title, title] });
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .update(nodes)
      .set({
        ...(input.title !== undefined ? { title } : {}),
        ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
        data,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id))
      .returning();
    if (!r) return r;
    return (await markContentChanged(tx, { id, type: 'present' }, changed)) ?? r;
  });
  if (!row) return null;
  const [p] = await db
    .select({ meta: presents.meta, rev: presents.rev, posterRev: presents.posterRev })
    .from(presents)
    .where(eq(presents.nodeId, id))
    .limit(1);
  return rowOf(row, p ?? null);
}

export async function deletePresent(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!row) return false;
  // The `presents` row and its revisions cascade.
  await headsOrSpace(
    (f) => withDeadlockRetry(() => withNodeDeleteHeads([id], f)),
    (tx) => tx.delete(nodes).where(eq(nodes.id, id)),
  );
  return true;
}

/** The kept past sources of a canvas, newest first (without the source). */
export async function listPresentRevisions(
  ownerId: string,
  id: string,
): Promise<{ rev: number; createdAt: string; bytes: number }[] | null> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!node) return null;
  const rows = await db
    .select({
      rev: presentRevisions.rev,
      createdAt: presentRevisions.createdAt,
      bytes: sql<number>`octet_length(${presentRevisions.source})`,
    })
    .from(presentRevisions)
    .where(eq(presentRevisions.nodeId, id))
    .orderBy(desc(presentRevisions.rev));
  return rows.map((r) => ({
    rev: r.rev,
    createdAt: r.createdAt.toISOString(),
    bytes: Number(r.bytes),
  }));
}

/** How long the flush waits for a canvas's row lock (a save holds it). */
export const PRESENT_FLUSH_LOCK_MS = 2_000;
/** How long a canvas whose flush failed is passed over. */
export const PRESENT_FLUSH_RETRY_MS = 5 * 60_000;
/** The canvases whose flush failed, to when they are tried again. Kept in
 *  the process: a held lock would refuse a write of the row's own mark. */
const flushRetryAt = new Map<string, number>();

/**
 * Re-index the canvases whose quiet period has passed (section 4.3): one
 * announcement each, through markContentChanged, then the due mark is
 * cleared. Run on the agent runtime's timer. Bounded per tick; a row whose
 * mark moved on since it was read (a save landed) is left for a later tick.
 * A row that fails (a lock held past PRESENT_FLUSH_LOCK_MS, a row gone
 * meanwhile) is passed over for PRESENT_FLUSH_RETRY_MS, so the same oldest
 * rows failing every tick never starve the rest. Returns how many were announced.
 */
export async function flushDuePresentIndex(limit = 25): Promise<number> {
  const now = Date.now();
  for (const [id, at] of flushRetryAt) if (at <= now) flushRetryAt.delete(id);
  const passed = [...flushRetryAt.keys()];
  const due = await db
    .select({ id: presents.nodeId })
    .from(presents)
    .where(
      and(
        isNotNull(presents.indexDueAt),
        lte(presents.indexDueAt, new Date()),
        ...(passed.length ? [notInArray(presents.nodeId, passed)] : []),
      ),
    )
    .orderBy(asc(presents.indexDueAt))
    .limit(limit);
  let announced = 0;
  for (const d of due) {
    // One canvas's failure (a lock, a row gone meanwhile) is that canvas's:
    // it is passed over for PRESENT_FLUSH_RETRY_MS, and the others are
    // announced now.
    const done = await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${PRESENT_FLUSH_LOCK_MS}ms'`));
        // Still due now: a save since the read pushed the mark on (compared
        // in the database, which keeps microseconds a JS Date drops).
        const cleared = await tx
          .update(presents)
          .set({ indexDueAt: null })
          .where(and(eq(presents.nodeId, d.id), lte(presents.indexDueAt, sql`now()`)))
          .returning({ id: presents.nodeId });
        if (cleared.length === 0) return false;
        await markContentChanged(tx, { id: d.id, type: 'present' }, ['source']);
        return true;
      })
      .catch(() => null);
    if (done) announced++;
    if (done === null) flushRetryAt.set(d.id, Date.now() + PRESENT_FLUSH_RETRY_MS);
  }
  return announced;
}

/**
 * Store a rendered poster (a CACHE of the canvas as a picture, section 7.4).
 * Written only when the canvas is still at `rev`, so a render of an older
 * save never stamps itself current. Never a content change: no index work,
 * no announcement (a render must not cause an extractor pass).
 */
export async function setPresentPoster(
  ownerId: string,
  id: string,
  png: Buffer,
  rev: number,
): Promise<boolean> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!node) return false;
  const written = await db
    .update(presents)
    .set({ posterPng: png, posterRev: rev })
    .where(and(eq(presents.nodeId, id), eq(presents.rev, rev)))
    .returning({ id: presents.nodeId });
  return written.length > 0;
}

/** The cached poster and whether it shows the latest save, or null. */
export async function getPresentPoster(
  ownerId: string,
  id: string,
): Promise<{ png: Buffer; current: boolean; posterRev: number } | null> {
  const [row] = await db
    .select({ png: presents.posterPng, posterRev: presents.posterRev, rev: presents.rev })
    .from(presents)
    .innerJoin(nodes, eq(nodes.id, presents.nodeId))
    .where(and(eq(presents.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!row?.png) return null;
  return { png: row.png, current: row.posterRev === row.rev, posterRev: row.posterRev ?? 0 };
}

/** What a page's canvas embed shows about the canvas, without its bytes:
 *  its title, its rev, and the rev its poster shows (null: none yet). Null
 *  when the canvas is not there for the caller (its scope reads no row). */
export async function getPresentEmbedFacts(
  ownerId: string,
  id: string,
): Promise<{ title: string; rev: number; posterRev: number | null } | null> {
  const [row] = await db
    .select({ title: nodes.title, rev: presents.rev, posterRev: presents.posterRev })
    .from(presents)
    .innerJoin(nodes, eq(nodes.id, presents.nodeId))
    .where(and(eq(presents.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'present')))
    .limit(1);
  if (!row) return null;
  return { title: row.title ?? '', rev: row.rev, posterRev: row.posterRev ?? null };
}

/** One kept version's source, or null (no such canvas or version). */
export async function getPresentRevisionSource(
  ownerId: string,
  id: string,
  rev: number,
): Promise<string | null> {
  const [row] = await db
    .select({ source: presentRevisions.source })
    .from(presentRevisions)
    .innerJoin(nodes, eq(nodes.id, presentRevisions.nodeId))
    .where(
      and(
        eq(presentRevisions.nodeId, id),
        eq(presentRevisions.rev, rev),
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'present'),
      ),
    )
    .limit(1);
  return row?.source ?? null;
}
