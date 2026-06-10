/**
 * Notes surface. A note is a `nodes` row with type='note':
 *
 *   nodes.title         display name
 *   nodes.data.content  markdown body (the extractor reads this)
 *   nodes.tags          freeform tags
 *
 * All under the `notes` ltree root. Lazy-created on first write. The
 * extractor already covers `note` in `DEFAULT_EXTRACT_TYPES`, so summary
 * + embedding land automatically on the next pg_notify('node_ingested').
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';

export const NOTES_ROOT_LABEL = 'notes';

export type NoteRow = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowOf(n: Node): NoteRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    title: n.title,
    content: typeof d.content === 'string' ? d.content : '',
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Notes',
      slug: NOTES_ROOT_LABEL,
      path: NOTES_ROOT_LABEL,
      data: { description: 'Markdown notes. Indexed and embedded automatically.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

type ListNotesOpts = { query?: string; tag?: string; includeDigests?: boolean };

/** Agent-minted digest tags (summarizer.ts): the digest marker itself plus its
 *  `agent:`/`topic:` companions. Used to hide machine notes from the Notes
 *  surface by default and to detect deep links that should reveal them. */
export function isDigestTag(tag: string): boolean {
  return tag === 'conversation-digest' || tag.startsWith('agent:') || tag.startsWith('topic:');
}

/** Shared WHERE conditions for note list/count queries. */
function noteConds(ownerId: string, opts: ListNotesOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'note')];
  // Agent conversation digests are Layer-3 memory, not user notes — keep them
  // out of note listings unless explicitly requested, either via the flag or
  // by filtering on one of the digest tags (which would otherwise match
  // nothing). The agent runtime reads digests straight from `nodes`
  // (conversation.ts), so its memory path is unaffected.
  if (!opts.includeDigests && !(opts.tag && isDigestTag(opts.tag))) {
    conds.push(sql`not (${nodes.tags} @> array['conversation-digest']::text[])`);
  }
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'content' ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listNotes(
  ownerId: string,
  opts: ListNotesOpts & { limit?: number; offset?: number } = {},
): Promise<NoteRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...noteConds(ownerId, opts)))
    .orderBy(desc(nodes.updatedAt))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

/** Total notes matching the same filters as `listNotes` (drives pagination). */
export async function countNotes(ownerId: string, opts: ListNotesOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...noteConds(ownerId, opts)));
  return row?.n ?? 0;
}

/** All distinct tags across the user's notes with usage counts, ordered by
 *  frequency then name. Drives the notes tag filter. Digest notes are excluded
 *  by default so their unbounded `topic:*` tags don't swamp the filter row. */
export async function listNoteTags(
  ownerId: string,
  opts: { includeDigests?: boolean } = {},
): Promise<{ tag: string; count: number }[]> {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'note')];
  if (!opts.includeDigests) {
    conds.push(sql`not (${nodes.tags} @> array['conversation-digest']::text[])`);
  }
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(...conds));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getNote(ownerId: string, id: string): Promise<NoteRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'note')))
    .limit(1);
  return row ? rowOf(row) : null;
}

export type CreateNoteInput = {
  title: string;
  content: string;
  tags?: string[];
};

export async function createNote(ownerId: string, input: CreateNoteInput): Promise<NoteRow> {
  await ensureRoot(ownerId);
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'note',
      title: input.title.trim().slice(0, 200) || 'Untitled note',
      path: NOTES_ROOT_LABEL,
      data: { content: input.content ?? '' },
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createNote: insert returned no row');
  return rowOf(row);
}

export type UpdateNoteInput = Partial<CreateNoteInput>;

export async function updateNote(
  ownerId: string,
  id: string,
  input: UpdateNoteInput,
): Promise<NoteRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'note')))
    .limit(1);
  if (!node) return null;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const contentChanged = input.content !== undefined && input.content !== oldData.content;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.content !== undefined) newData.content = input.content;
  // Content change invalidates the extractor's prior summary/embedding.
  if (contentChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }
  const [updated] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled note' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(contentChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateNote: update returned no row');
  if (contentChanged) {
    await notifyNodeIngested(id);
  }
  return rowOf(updated);
}

export async function deleteNote(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'note')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id));
  return true;
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
