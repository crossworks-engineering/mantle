/**
 * Life Logs surface. A life log is a `nodes` row with type='lifelog':
 *
 *   nodes.title          short display title (auto-derived from body if blank)
 *   nodes.data.body      the entry — a short plain-text paragraph
 *   nodes.data.mood      optional mood (see MOODS); free text tolerated
 *   nodes.data.category  optional life area (see CATEGORIES); free text tolerated
 *   nodes.data.entry_date  optional ISO date the entry is "about" (defaults to created_at)
 *   nodes.tags           freeform tags
 *
 * All under the `lifelog` ltree root. Lazy-created on first write. `lifelog`
 * is in the extractor's `DEFAULT_EXTRACT_TYPES`, so summary + 768-dim
 * embedding + facts land automatically on the next pg_notify('node_ingested').
 *
 * Unlike notes, life logs are also distilled into the always-on "who you are"
 * identity block injected into every agent turn — see ./identity-context.ts.
 * That's the whole point: a life log teaches agents who the user is.
 */
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';

export const LIFELOG_ROOT_LABEL = 'lifelog';

// Mood + category option lists live in a browser-safe leaf (no @mantle/db) so
// the client editor/filters can import them without bundling postgres.
// Re-exported here for server callers that import from '@mantle/content'.
export {
  MOODS,
  MOOD_KEYS,
  CATEGORIES,
  CATEGORY_KEYS,
  moodDisplay,
  categoryLabel,
  type MoodKey,
  type CategoryKey,
} from './lifelog-options';

export type LifelogRow = {
  id: string;
  title: string;
  body: string;
  mood: string | null;
  category: string | null;
  entryDate: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

function str(d: Record<string, unknown>, k: string): string | null {
  const v = d[k];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function rowOf(n: Node): LifelogRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    title: n.title,
    body: typeof d.body === 'string' ? d.body : '',
    mood: str(d, 'mood'),
    category: str(d, 'category'),
    entryDate: str(d, 'entry_date'),
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
      title: 'Life Logs',
      slug: LIFELOG_ROOT_LABEL,
      path: LIFELOG_ROOT_LABEL,
      data: {
        description:
          'A personal life log — who I am, what I do, how I feel. Indexed, embedded, and distilled into the assistant’s identity context.',
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

/** Derive a compact title from the entry body (first sentence / ~60 chars).
 *  Keeps the left-list readable when the user just types a paragraph. */
function deriveTitle(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Life log';
  const firstSentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  const base = firstSentence.length <= 60 ? firstSentence : `${flat.slice(0, 57).trimEnd()}…`;
  return base.slice(0, 200);
}

type ListLifelogsOpts = {
  query?: string;
  mood?: string;
  category?: string;
  tag?: string;
};

/** Shared WHERE conditions for lifelog list/count queries. */
function lifelogConds(ownerId: string, opts: ListLifelogsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'lifelog')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'body' ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.mood) conds.push(sql`${nodes.data}->>'mood' = ${opts.mood}`);
  if (opts.category) conds.push(sql`${nodes.data}->>'category' = ${opts.category}`);
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listLifelogs(
  ownerId: string,
  opts: ListLifelogsOpts & { limit?: number; offset?: number } = {},
): Promise<LifelogRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...lifelogConds(ownerId, opts)))
    // Newest first by the "about" date when set, else by update time. The
    // COALESCE keeps backdated entries sorting by when they happened.
    .orderBy(sql`coalesce((${nodes.data}->>'entry_date')::timestamptz, ${nodes.updatedAt}) desc`)
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

/** Total life logs matching the same filters as `listLifelogs`. */
export async function countLifelogs(
  ownerId: string,
  opts: ListLifelogsOpts = {},
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...lifelogConds(ownerId, opts)));
  return row?.n ?? 0;
}

/** All distinct tags across the user's life logs with usage counts. */
export async function listLifelogTags(
  ownerId: string,
): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'lifelog')));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getLifelog(ownerId: string, id: string): Promise<LifelogRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'lifelog')))
    .limit(1);
  return row ? rowOf(row) : null;
}

export type CreateLifelogInput = {
  body: string;
  title?: string;
  mood?: string;
  category?: string;
  entryDate?: string;
  tags?: string[];
};

export async function createLifelog(
  ownerId: string,
  input: CreateLifelogInput,
): Promise<LifelogRow> {
  await ensureRoot(ownerId);
  const body = (input.body ?? '').trim();
  const data: Record<string, unknown> = { body };
  const mood = input.mood?.trim();
  const category = input.category?.trim();
  const entryDate = input.entryDate?.trim();
  if (mood) data.mood = mood;
  if (category) data.category = category;
  if (entryDate) data.entry_date = entryDate;
  const title = input.title?.trim() || deriveTitle(body);
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'lifelog',
      title: title.slice(0, 200) || 'Life log',
      path: LIFELOG_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createLifelog: insert returned no row');
  return rowOf(row);
}

export type UpdateLifelogInput = Partial<CreateLifelogInput>;

export async function updateLifelog(
  ownerId: string,
  id: string,
  input: UpdateLifelogInput,
): Promise<LifelogRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'lifelog')))
    .limit(1);
  if (!node) return null;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const bodyChanged = input.body !== undefined && input.body.trim() !== oldData.body;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.body !== undefined) newData.body = input.body.trim();
  // mood/category/entry_date are cleared when an empty string is passed.
  if (input.mood !== undefined) {
    const m = input.mood.trim();
    if (m) newData.mood = m;
    else delete newData.mood;
  }
  if (input.category !== undefined) {
    const c = input.category.trim();
    if (c) newData.category = c;
    else delete newData.category;
  }
  if (input.entryDate !== undefined) {
    const e = input.entryDate.trim();
    if (e) newData.entry_date = e;
    else delete newData.entry_date;
  }
  // A body change invalidates the extractor's prior summary/embedding. Mood /
  // category / date are metadata only — they don't trigger re-extraction (the
  // body carries the semantic payload), keeping edits cost-safe.
  if (bodyChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }
  // Re-derive the title only when the caller didn't pass one AND the body
  // changed AND the stored title still looks auto-derived from the old body.
  let nextTitle: string | undefined;
  if (input.title !== undefined) {
    nextTitle = input.title.trim().slice(0, 200) || deriveTitle(newData.body as string);
  } else if (bodyChanged && node.title === deriveTitle((oldData.body as string) ?? '')) {
    nextTitle = deriveTitle(newData.body as string);
  }
  const [updated] = await db
    .update(nodes)
    .set({
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(bodyChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateLifelog: update returned no row');
  if (bodyChanged) {
    await notifyNodeIngested(id);
  }
  return rowOf(updated);
}

export async function deleteLifelog(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'lifelog')))
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
