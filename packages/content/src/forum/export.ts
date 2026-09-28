/**
 * The Forum archive (member logins, Phase 6): the retired team forum, frozen
 * into admin-level pages before the forum tables are deleted.
 *
 *   - One page per topic, private topics included, under a single "Forum
 *     archive" parent page. Every post keeps its author (name and kind), time,
 *     body (markdown), the agent's name and model and a link to its trace,
 *     and its attachments as links to their file nodes.
 *   - Uploads the admin never reviewed (`staged` / `pending`) are filed into
 *     `files/review/forum-archive` with metadata-only indexing (name, type and
 *     folder; the content is never read), then linked. An upload whose bytes
 *     are gone is named in the page and the dump, and stays as it was.
 *   - One JSON dump of the whole forum at `files/archive/forum-<date>.json`
 *     (metadata-only indexing).
 *   - A task filed from a topic (`data.teamRequest.topicId`) gets
 *     `data.teamRequest.archivePageId`.
 *
 * Cost-safe by construction: the pages carry `data.source = 'forum-archive'`,
 * which the extractor refuses before any pass (@mantle/db extract-exempt.ts),
 * and the filed files and the dump are metadata-only (no LLM; one local spine
 * embedding each, like any metadata file). Nothing here calls a model or the
 * embedder, and nothing notifies the extractor beyond the insert trigger every
 * node has.
 *
 * Idempotent: `forum_topics.node_id` (reserved since migration 0123, never
 * written before this) is the per-topic done-marker, and every write adopts
 * what an interrupted earlier run left (the page by topic id, a filed upload
 * by upload id), so a second run creates nothing. A topic with an agent reply
 * still in flight is deferred to a later run. Two runs at once cannot happen:
 * the run holds a transaction-scoped advisory lock and a second caller gets
 * `busy` back.
 *
 * Callers: POST /api/team-admin/forum/export (admin) and the api server's
 * boot task, which runs only while unexported topics exist.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  db,
  forumPosts,
  forumTopics,
  forumUploads,
  nodes,
  FORUM_ARCHIVE_SOURCE,
  type ConversationAttachment,
  type ForumPost,
  type ForumTopic,
  type ForumUpload,
} from '@mantle/db';
import { markdownToDoc } from '@mantle/content-core/markdown';
import {
  createFolder,
  dashToLtree,
  deleteQuarantineBytes,
  ensureFilesRootBranch,
  readQuarantineBytes,
  upsertFile,
} from '@mantle/files';
import { createPage } from '../pages/tree';
import { dedupeFilename } from '../dedupe-filename';
import { formatAttachmentSize } from '../forum-uploads-meta';

/** The folder unreviewed uploads are filed into (ltree form). */
export const FORUM_ARCHIVE_UPLOADS_PATH = 'files.review.forum_archive';
/** The folder the JSON dump lands in (ltree form). */
export const FORUM_ARCHIVE_DUMP_PATH = 'files.archive';
/** Title of the single parent page. */
export const FORUM_ARCHIVE_TITLE = 'Forum archive';
/** Tag on every archive page and file. */
export const FORUM_ARCHIVE_TAG = 'forum-archive';

export type ForumExportResult =
  | { status: 'busy' }
  | {
      status: 'done';
      /** Topics given a page by THIS run. */
      exported: number;
      /** Topics left for a later run (an agent reply still in flight). */
      deferred: number;
      /** Topics already exported before this run. */
      alreadyExported: number;
      /** The "Forum archive" parent page, null when nothing was ever exported. */
      archivePageId: string | null;
      /** The JSON dump file node, null when this run exported nothing. */
      dumpFileId: string | null;
      /** Unreviewed uploads filed into files/review/forum-archive. */
      uploadsFiled: number;
      /** Unreviewed uploads whose bytes were gone. */
      uploadsMissing: number;
      /** Tasks given (or corrected to) their topic's archivePageId. */
      tasksLinked: number;
    };

/** Topics with no archive page yet. The boot task runs only when this is > 0. */
export async function countUnexportedForumTopics(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(forumTopics)
    .where(and(eq(forumTopics.ownerId, ownerId), isNull(forumTopics.nodeId)));
  return row?.n ?? 0;
}

/** Export the forum. Returns `busy` when another run holds the lock. */
export async function exportForumArchive(
  ownerId: string,
  opts: { now?: Date } = {},
): Promise<ForumExportResult> {
  // The transaction exists to scope the advisory lock (released on commit or
  // rollback, even if the process dies). The work runs on other pool
  // connections in its own short writes: the maintenance-sweep pattern.
  return db.transaction(async (tx) => {
    const res = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`forum-export:${ownerId}`}, 0)) as locked`,
    )) as unknown;
    const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
      locked: boolean;
    }[];
    if (!rows[0]?.locked) return { status: 'busy' } as const;
    return runExport(ownerId, opts.now ?? new Date());
  });
}

export type UploadOutcome = { nodeId: string | null; missing: boolean };

async function runExport(ownerId: string, now: Date): Promise<ForumExportResult> {
  const topics = await db
    .select()
    .from(forumTopics)
    .where(eq(forumTopics.ownerId, ownerId))
    .orderBy(asc(forumTopics.createdAt), asc(forumTopics.id));
  const inFlight = new Set(
    (
      await db
        .selectDistinct({ topicId: forumPosts.topicId })
        .from(forumPosts)
        .where(and(eq(forumPosts.ownerId, ownerId), eq(forumPosts.status, 'pending')))
    ).map((r) => r.topicId),
  );
  const todo = topics.filter((t) => !t.nodeId && !inFlight.has(t.id));
  const deferred = topics.filter((t) => !t.nodeId && inFlight.has(t.id)).length;
  const alreadyExported = topics.length - todo.length - deferred;

  let archivePageId = await findArchiveRoot(ownerId);
  const outcomes = new Map<string, UploadOutcome>();
  let dumpFileId: string | null = null;

  if (todo.length > 0) {
    archivePageId ??= await createArchiveRoot(ownerId, now);

    // File every unreviewed upload of a topic being exported, and the
    // topic-less staged ones (a new-topic dialog that was never sent).
    const todoIds = new Set(todo.map((t) => t.id));
    const unreviewed = await db
      .select()
      .from(forumUploads)
      .where(
        and(eq(forumUploads.ownerId, ownerId), inArray(forumUploads.status, ['staged', 'pending'])),
      )
      .orderBy(asc(forumUploads.createdAt), asc(forumUploads.id));
    const toFile = unreviewed.filter((u) => !u.topicId || todoIds.has(u.topicId));
    if (toFile.length > 0) {
      const folder = await ensureFolder(ownerId, [
        ['files', 'review', 'Member uploads approved from the team forum.'],
        ['files.review', 'forum-archive', 'Forum uploads nobody reviewed, filed by the archive.'],
      ]);
      for (const u of toFile) outcomes.set(u.id, await fileUpload(ownerId, folder, u, now));
    }

    for (const topic of todo) {
      const pageId = await archiveTopic(ownerId, archivePageId, topic, outcomes);
      await db
        .update(forumTopics)
        .set({ nodeId: pageId })
        .where(and(eq(forumTopics.id, topic.id), isNull(forumTopics.nodeId)));
    }
  }

  // Every run, over every archived topic: a crash between a topic's page and
  // its tasks must not leave the tasks unlinked for good.
  const tasksLinked = await linkRequestTasks(ownerId);

  if (todo.length > 0 && archivePageId) {
    dumpFileId = await writeDump(ownerId, archivePageId, now, outcomes);
  }

  const filed = [...outcomes.values()];
  return {
    status: 'done',
    exported: todo.length,
    deferred,
    alreadyExported,
    archivePageId,
    dumpFileId,
    uploadsFiled: filed.filter((o) => o.nodeId).length,
    uploadsMissing: filed.filter((o) => o.missing).length,
    tasksLinked,
  };
}

// ── The pages ────────────────────────────────────────────────────────────────

/** Provenance on an archive page. `source` is what exempts it from extraction. */
type ArchivePageData = {
  source: typeof FORUM_ARCHIVE_SOURCE;
  forumArchive: { kind: 'index' } | { kind: 'topic'; topicId: string; visibility: string };
};

async function findArchivePage(ownerId: string, match: SQL): Promise<string | null> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'page'),
        sql`${nodes.data}->>'source' = ${FORUM_ARCHIVE_SOURCE}`,
        match,
      ),
    )
    .orderBy(asc(nodes.createdAt))
    .limit(1);
  return row?.id ?? null;
}

function findArchiveRoot(ownerId: string): Promise<string | null> {
  return findArchivePage(ownerId, sql`${nodes.data}->'forumArchive'->>'kind' = 'index'`);
}

async function createArchiveRoot(ownerId: string, now: Date): Promise<string> {
  const markdown = [
    `The team forum closed on ${day(now)}. Each page below is one of its topics, private ones included, with every post as it was written.`,
    '',
    'These pages are admin level and stay out of the brain: nothing indexes them, so search and the agents never read them. To show a page to the team, open it and set its access level by hand.',
    '',
    'Uploads nobody had reviewed were filed into Files, review, forum-archive. The whole forum is also kept as one JSON file in Files, archive.',
  ].join('\n');
  const data: ArchivePageData = { source: FORUM_ARCHIVE_SOURCE, forumArchive: { kind: 'index' } };
  const page = await createPage(ownerId, {
    title: FORUM_ARCHIVE_TITLE,
    doc: markdownToDoc(markdown),
    tags: [FORUM_ARCHIVE_TAG],
    data,
  });
  return page.id;
}

async function archiveTopic(
  ownerId: string,
  rootId: string,
  topic: ForumTopic,
  outcomes: Map<string, UploadOutcome>,
): Promise<string> {
  // Adopt a page an interrupted run created before it could set node_id.
  const existing = await findArchivePage(
    ownerId,
    sql`${nodes.data}->'forumArchive'->>'topicId' = ${topic.id}`,
  );
  if (existing) return existing;

  const posts = await db
    .select()
    .from(forumPosts)
    .where(and(eq(forumPosts.ownerId, ownerId), eq(forumPosts.topicId, topic.id)))
    .orderBy(asc(forumPosts.createdAt), asc(forumPosts.id));
  const uploads = await db
    .select()
    .from(forumUploads)
    .where(and(eq(forumUploads.ownerId, ownerId), eq(forumUploads.topicId, topic.id)));
  const nodeTitles = await titlesOf(
    ownerId,
    posts.flatMap((p) => (p.attachments ?? []).map((a) => a.nodeId).filter(isString)),
  );

  const markdown = topicMarkdown(topic, posts, {
    uploads: new Map(uploads.map((u) => [u.id, u])),
    outcomes,
    nodeTitles,
  });
  const data: ArchivePageData = {
    source: FORUM_ARCHIVE_SOURCE,
    forumArchive: { kind: 'topic', topicId: topic.id, visibility: topic.visibility },
  };
  const page = await createPage(ownerId, {
    title: topic.title,
    doc: markdownToDoc(markdown),
    parentId: rootId,
    tags: [FORUM_ARCHIVE_TAG],
    data,
  });
  return page.id;
}

export type TopicAttachmentContext = {
  uploads: Map<string, ForumUpload>;
  outcomes: Map<string, UploadOutcome>;
  nodeTitles: Map<string, string>;
};

/** The page body (markdown) for one topic. Exported for the unit test. */
export function topicMarkdown(
  topic: Pick<ForumTopic, 'kind' | 'visibility' | 'status' | 'pinned' | 'authorName' | 'createdAt'>,
  posts: ForumPost[],
  ctx: TopicAttachmentContext,
): string {
  const facts = [
    topic.visibility === 'private' ? 'Private topic (its author and the admins)' : 'Team topic',
    `kind ${topic.kind}`,
    `status ${topic.status}`,
    ...(topic.pinned ? ['pinned'] : []),
    `started by ${topic.authorName} on ${stamp(topic.createdAt)}`,
    `${posts.length} post${posts.length === 1 ? '' : 's'}`,
  ];
  const out: string[] = [`_${facts.join(' · ')}_`];
  for (const post of posts) {
    out.push(
      '',
      '---',
      '',
      `### ${post.authorName} (${post.authorKind}) · ${stamp(post.createdAt)}`,
    );
    if (post.authorKind === 'agent') {
      const meta = [`Agent ${post.authorName}`];
      if (post.model) meta.push(`model ${post.model}`);
      if (post.traceId) meta.push(`[trace ${post.traceId}](/traces/${post.traceId})`);
      out.push('', `_${meta.join(' · ')}_`);
    }
    if (post.editedAt) out.push('', `_Edited ${stamp(post.editedAt)}_`);
    if (post.status === 'failed') {
      out.push('', `_This reply failed${post.error ? `: ${post.error}` : ''}._`);
    }
    if (post.body.trim()) out.push('', post.body.trim());
    const links = (post.attachments ?? []).map((a) => attachmentLink(a, ctx));
    if (links.length > 0) out.push('', `Attachments: ${links.join(' · ')}`);
  }
  return out.join('\n');
}

function attachmentLink(att: ConversationAttachment, ctx: TopicAttachmentContext): string {
  if (att.nodeId) {
    return mention(ctx.nodeTitles.get(att.nodeId) ?? att.caption ?? att.kind, att.nodeId);
  }
  const upload = att.fileId ? ctx.uploads.get(att.fileId) : undefined;
  if (!upload) return `${att.caption ?? att.kind} (not found)`;
  const label = `${upload.filename} (${formatAttachmentSize(upload.sizeBytes)})`;
  const nodeId = upload.nodeId ?? ctx.outcomes.get(upload.id)?.nodeId ?? null;
  if (nodeId) return mention(label, nodeId);
  if (upload.status === 'dismissed') return `${label}, dismissed by the admin`;
  return `${label}, the uploaded bytes were gone`;
}

/** A node mention chip: the page dialect's link to a brain item. */
function mention(label: string, nodeId: string): string {
  return `[${label.replace(/[[\]]/g, '')}](mention:node:${nodeId})`;
}

async function titlesOf(ownerId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, [...new Set(ids)])));
  return new Map(rows.map((r) => [r.id, r.title]));
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Create each missing folder level and return the last one's ltree path,
 *  flagged metadata-only. Tolerates a concurrent create. */
async function ensureFolder(
  ownerId: string,
  levels: ReadonlyArray<readonly [parent: string, slug: string, description: string]>,
): Promise<string> {
  await ensureFilesRootBranch(ownerId);
  let path = 'files';
  for (const [parent, slug, description] of levels) {
    path = `${parent}.${dashToLtree(slug)}`;
    const [found] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'branch'),
          sql`${nodes.path}::text = ${path}`,
        ),
      )
      .limit(1);
    if (found) continue;
    try {
      await createFolder({ ownerId, parentPath: parent, slug, description });
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
    }
  }
  // Metadata-only for the whole folder, so a file added by hand later is too.
  // A plain data write: no notify, nothing re-queued.
  await db
    .update(nodes)
    .set({ data: sql`${nodes.data} || '{"indexing":"metadata"}'::jsonb` })
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${path}`,
        sql`${nodes.data}->>'indexing' is distinct from 'metadata'`,
      ),
    );
  return path;
}

async function fileUpload(
  ownerId: string,
  folder: string,
  upload: ForumUpload,
  now: Date,
): Promise<UploadOutcome> {
  // Adopt what an interrupted run filed (by upload id, not by name).
  const [adopted] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text = ${folder}`,
        sql`${nodes.data}->'forumArchive'->>'uploadId' = ${upload.id}`,
      ),
    )
    .limit(1);
  let nodeId = adopted?.id ?? null;
  if (!nodeId) {
    const bytes = await readQuarantineBytes(ownerId, upload.id);
    if (!bytes) return { nodeId: null, missing: true };
    const taken = await db
      .select({ filename: sql<string>`${nodes.data}->>'filename'` })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'file'),
          sql`${nodes.path}::text = ${folder}`,
        ),
      );
    const row = await upsertFile({
      ownerId,
      parentPath: folder,
      filename: dedupeFilename(upload.filename, new Set(taken.map((t) => t.filename))),
      bytes,
      tags: [FORUM_ARCHIVE_TAG],
      data: {
        indexing: 'metadata',
        forumArchive: {
          uploadId: upload.id,
          topicId: upload.topicId,
          postId: upload.postId,
          contactId: upload.contactId,
          status: upload.status,
        },
      },
    });
    nodeId = row.id;
  }
  await db
    .update(forumUploads)
    .set({ status: 'filed', nodeId, reviewedAt: now })
    .where(
      and(eq(forumUploads.id, upload.id), inArray(forumUploads.status, ['staged', 'pending'])),
    );
  await deleteQuarantineBytes(ownerId, upload.id);
  return { nodeId, missing: false };
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/** `data.teamRequest.archivePageId` on every task filed from an archived
 *  topic. Only rows that lack it (or carry another value) are written. */
async function linkRequestTasks(ownerId: string): Promise<number> {
  const res = (await db.execute(sql`
    update nodes n
       set data = jsonb_set(n.data, '{teamRequest,archivePageId}', to_jsonb(t.node_id::text))
      from forum_topics t
     where n.owner_id = ${ownerId}
       and n.type = 'task'
       and t.owner_id = ${ownerId}
       and t.node_id is not null
       and n.data->'teamRequest'->>'topicId' = t.id::text
       and n.data->'teamRequest'->>'archivePageId' is distinct from t.node_id::text
    returning n.id`)) as unknown;
  const rows = Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? []);
  return rows.length;
}

// ── The dump ─────────────────────────────────────────────────────────────────

async function writeDump(
  ownerId: string,
  archivePageId: string,
  now: Date,
  outcomes: Map<string, UploadOutcome>,
): Promise<string> {
  const topics = await db
    .select()
    .from(forumTopics)
    .where(eq(forumTopics.ownerId, ownerId))
    .orderBy(asc(forumTopics.createdAt), asc(forumTopics.id));
  const posts = await db
    .select()
    .from(forumPosts)
    .where(eq(forumPosts.ownerId, ownerId))
    .orderBy(asc(forumPosts.createdAt), asc(forumPosts.id));
  const uploads = await db
    .select()
    .from(forumUploads)
    .where(eq(forumUploads.ownerId, ownerId))
    .orderBy(asc(forumUploads.createdAt), asc(forumUploads.id));
  const tasks = await db
    .select({ id: nodes.id, title: nodes.title, teamRequest: sql`${nodes.data}->'teamRequest'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'task'),
        isNotNull(sql`${nodes.data}->'teamRequest'->>'topicId'`),
      ),
    );

  const byTopic = new Map<string, ForumPost[]>();
  for (const p of posts) byTopic.set(p.topicId, [...(byTopic.get(p.topicId) ?? []), p]);
  const dump = {
    format: 'mantle.forum-archive/1',
    exportedAt: now.toISOString(),
    archivePageId,
    topics: topics.map((t) => ({ ...t, archivePageId: t.nodeId, posts: byTopic.get(t.id) ?? [] })),
    uploads: uploads.map((u) => ({ ...u, bytesMissing: outcomes.get(u.id)?.missing ?? false })),
    requestTasks: tasks,
  };

  const folder = await ensureFolder(ownerId, [['files', 'archive', 'Archived exports.']]);
  const row = await upsertFile({
    ownerId,
    parentPath: folder,
    filename: `forum-${day(now)}.json`,
    bytes: Buffer.from(JSON.stringify(dump, null, 2)),
    overwrite: true,
    tags: [FORUM_ARCHIVE_TAG],
    data: { indexing: 'metadata', forumArchive: { kind: 'dump' } },
  });
  return row.id;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function stamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
