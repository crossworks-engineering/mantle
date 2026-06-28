/**
 * Journal surface. A journal entry is a `nodes` row with type='journal':
 *
 *   nodes.title          short display title (auto-derived from body if blank)
 *   nodes.data.body      the entry — a short plain-text paragraph
 *   nodes.data.mood      optional mood (see MOODS); free text tolerated
 *   nodes.data.category  optional life area (see CATEGORIES); free text tolerated
 *   nodes.data.entry_date  optional ISO date the entry is "about" (defaults to created_at)
 *   nodes.tags           freeform tags
 *
 * All under the `journal` ltree root. Lazy-created on first write. `journal`
 * is in the extractor's `DEFAULT_EXTRACT_TYPES`, so summary + 768-dim
 * embedding + facts land automatically on the next pg_notify('node_ingested').
 *
 * Unlike notes, journal entries are also distilled into the always-on "who you are"
 * identity block injected into every agent turn — see ./identity-context.ts.
 * That's the whole point: a journal entry teaches agents who the user is.
 */
import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';
import { normalizeEntryDate } from './journal-options';

export const JOURNAL_ROOT_LABEL = 'journal';

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
  normalizeEntryDate,
  type MoodKey,
  type CategoryKey,
} from './journal-options';

/**
 * Sort key for journal entries: the "about" date when set, else the row's update
 * time, newest first. The cast is **crash-proof** — only values that look
 * date-like (`YYYY-MM-DD…`) are cast to `timestamptz`; anything else falls
 * through to `updated_at`. Input validation (`normalizeEntryDate`) already
 * guarantees stored `entry_date` is canonical ISO, so this guard only ever
 * matters for legacy / direct-DB-written rows — but without it a single bad
 * value would throw and break the ENTIRE list + identity block. Shared by
 * `listJournals` and `buildIdentityContext` so the two never drift.
 */
export function journalSortSql(): SQL {
  return sql`coalesce(
    case when ${nodes.data}->>'entry_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
      then (${nodes.data}->>'entry_date')::timestamptz end,
    ${nodes.updatedAt}
  ) desc`;
}

export type JournalRow = {
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

function rowOf(n: Node): JournalRow {
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
      title: 'Journal',
      slug: JOURNAL_ROOT_LABEL,
      path: JOURNAL_ROOT_LABEL,
      data: {
        description:
          'My journal — who I am, what I do, how I feel. Indexed, embedded, and distilled into the assistant’s identity context.',
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

/** Derive a compact title from the entry body (first sentence / ~60 chars).
 *  Keeps the left-list readable when the user just types a paragraph.
 *  Exported for unit tests. */
export function deriveTitle(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Journal entry';
  const firstSentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  const base = firstSentence.length <= 60 ? firstSentence : `${flat.slice(0, 57).trimEnd()}…`;
  return base.slice(0, 200);
}

type ListJournalsOpts = {
  query?: string;
  mood?: string;
  category?: string;
  tag?: string;
};

/** Shared WHERE conditions for journal list/count queries. */
function journalConds(ownerId: string, opts: ListJournalsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')];
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

export async function listJournals(
  ownerId: string,
  opts: ListJournalsOpts & { limit?: number; offset?: number } = {},
): Promise<JournalRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...journalConds(ownerId, opts)))
    // Newest first by the "about" date when set, else by update time.
    .orderBy(journalSortSql())
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

/** Total journal entries matching the same filters as `listJournals`. */
export async function countJournals(
  ownerId: string,
  opts: ListJournalsOpts = {},
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...journalConds(ownerId, opts)));
  return row?.n ?? 0;
}

/** All distinct tags across the user's journal entries with usage counts. */
export async function listJournalTags(
  ownerId: string,
): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getJournal(ownerId: string, id: string): Promise<JournalRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')))
    .limit(1);
  return row ? rowOf(row) : null;
}

export type CreateJournalInput = {
  body: string;
  title?: string;
  mood?: string;
  category?: string;
  entryDate?: string;
  tags?: string[];
};

export async function createJournal(
  ownerId: string,
  input: CreateJournalInput,
): Promise<JournalRow> {
  await ensureRoot(ownerId);
  const body = (input.body ?? '').trim();
  const data: Record<string, unknown> = { body };
  const mood = input.mood?.trim();
  const category = input.category?.trim();
  if (mood) data.mood = mood;
  if (category) data.category = category;
  if (input.entryDate?.trim()) {
    // Validate before storing — a non-date string would poison the sort cast.
    const iso = normalizeEntryDate(input.entryDate);
    if (!iso) throw new Error('entry_date must be a valid date (ISO 8601)');
    data.entry_date = iso;
  }
  const title = input.title?.trim() || deriveTitle(body);
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'journal',
      title: title.slice(0, 200) || 'Journal entry',
      path: JOURNAL_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createJournal: insert returned no row');
  return rowOf(row);
}

export type UpdateJournalInput = Partial<CreateJournalInput>;

export async function updateJournal(
  ownerId: string,
  id: string,
  input: UpdateJournalInput,
): Promise<JournalRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')))
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
    if (e) {
      const iso = normalizeEntryDate(e);
      if (!iso) throw new Error('entry_date must be a valid date (ISO 8601)');
      newData.entry_date = iso;
    } else {
      delete newData.entry_date;
    }
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
  if (!updated) throw new Error('updateJournal: update returned no row');
  if (bodyChanged) {
    await notifyNodeIngested(id);
  }
  return rowOf(updated);
}

export async function deleteJournal(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')))
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
