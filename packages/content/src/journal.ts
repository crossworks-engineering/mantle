/**
 * Journal surface. A journal entry is a `nodes` row with type='journal':
 *
 *   nodes.title            short display title (auto-derived from body if blank)
 *   nodes.data.body        the entry — a short plain-text paragraph
 *   nodes.data.author      'user' | 'agent' — stamped server-side (never model-supplied)
 *   nodes.data.agent_slug  authoring agent's slug when author='agent'
 *   nodes.data.kind        optional kind (see KINDS); free text tolerated
 *   nodes.data.status      gap lifecycle ('open'|'resolved'); kind='gap' only
 *   nodes.data.resolved_at ISO timestamp set when a gap is resolved
 *   nodes.data.entry_date  optional ISO date the entry is "about" (defaults to created_at)
 *   nodes.tags             freeform tags
 *
 * All under the `journal` ltree root. Lazy-created on first write. `journal`
 * is in the extractor's `DEFAULT_EXTRACT_TYPES`, so summary + 768-dim
 * embedding + facts land automatically on the next pg_notify('node_ingested').
 *
 * Two lanes, one type (docs/journal.md): user-lane kinds feed the always-on
 * "# About the user" block; agent-lane kinds (lesson/expectation/gap) feed the
 * per-turn "# Working notes" block — see ./identity-context.ts. Gap entries
 * are open questions the brain wants answered; `resolveGapEntry` closes one
 * and records the answer as durable user-lane knowledge.
 *
 * Legacy pre-v2 rows carry `mood`/`category` in jsonb. Nothing reads `mood`
 * anymore; `category` maps to a kind at read time (legacyCategoryToKind).
 */
import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';
import { legacyCategoryToKind, normalizeEntryDate } from './journal-options';

export const JOURNAL_ROOT_LABEL = 'journal';

// Kind/status option lists live in a browser-safe leaf (no @mantle/db) so
// the client editor/filters can import them without bundling postgres.
// Re-exported here for server callers that import from '@mantle/content'.
export {
  KINDS,
  KIND_KEYS,
  USER_KIND_KEYS,
  AGENT_KIND_KEYS,
  GAP_STATUSES,
  kindLabel,
  kindLane,
  legacyCategoryToKind,
  normalizeEntryDate,
  type KindKey,
  type JournalLane,
  type GapStatus,
} from './journal-options';
import type { JournalRow } from '@mantle/client-types';
export type { JournalRow };

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

/** Effective kind of a row in SQL, with the legacy `category` mapping applied
 *  (rows written before kinds existed have no `kind`). Mirrors
 *  `legacyCategoryToKind` — keep the two in step. */
function journalKindSql(): SQL {
  return sql`coalesce(
    nullif(${nodes.data}->>'kind', ''),
    case ${nodes.data}->>'category'
      when 'identity' then 'identity'
      when 'goal' then 'goal'
      else 'context'
    end
  )`;
}

function str(d: Record<string, unknown>, k: string): string | null {
  const v = d[k];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function rowOf(n: Node): JournalRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const kind = str(d, 'kind');
  return {
    id: n.id,
    title: n.title,
    body: typeof d.body === 'string' ? d.body : '',
    author: d.author === 'agent' ? 'agent' : 'user',
    agentSlug: str(d, 'agent_slug'),
    // Legacy rows (no kind) surface their old category mapped to a kind, so
    // every consumer sees ONE vocabulary.
    kind: kind ?? legacyCategoryToKind(str(d, 'category')),
    status: str(d, 'status'),
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
          'The brain’s experience log — durable self-knowledge from the user, working notes and open questions from the agents. Indexed, embedded, and distilled into every agent turn.',
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
  /** Effective kind — matches legacy rows via their mapped category. */
  kind?: string;
  /** Whole-lane filter: 'user' = identity/context/preference/goal (legacy rows
   *  included via the category mapping), 'agent' = lesson/expectation/gap.
   *  Drives the /journal view tabs; `kind` narrows further within a lane. */
  lane?: 'user' | 'agent';
  author?: 'user' | 'agent';
  /** Gap lifecycle filter; meaningful with kind='gap'. */
  status?: string;
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
  if (opts.kind) conds.push(sql`${journalKindSql()} = ${opts.kind}`);
  if (opts.lane === 'agent') {
    conds.push(sql`${journalKindSql()} in ('lesson', 'expectation', 'gap')`);
  } else if (opts.lane === 'user') {
    conds.push(sql`${journalKindSql()} not in ('lesson', 'expectation', 'gap')`);
  }
  if (opts.author) {
    conds.push(sql`coalesce(nullif(${nodes.data}->>'author', ''), 'user') = ${opts.author}`);
  }
  if (opts.status) conds.push(sql`${nodes.data}->>'status' = ${opts.status}`);
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
export async function countJournals(ownerId: string, opts: ListJournalsOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...journalConds(ownerId, opts)));
  return row?.n ?? 0;
}

/** All distinct tags across the user's journal entries with usage counts. */
export async function listJournalTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
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
  kind?: string;
  entryDate?: string;
  tags?: string[];
  /** Provenance — set by the SERVER from the calling context (tool loop agent
   *  slug, REST session), never from model-supplied args. Defaults to 'user'. */
  author?: 'user' | 'agent';
  agentSlug?: string;
};

export async function createJournal(
  ownerId: string,
  input: CreateJournalInput,
): Promise<JournalRow> {
  await ensureRoot(ownerId);
  const body = (input.body ?? '').trim();
  const data: Record<string, unknown> = { body };
  const kind = input.kind?.trim();
  if (kind) data.kind = kind;
  data.author = input.author === 'agent' ? 'agent' : 'user';
  if (input.author === 'agent' && input.agentSlug?.trim()) {
    data.agent_slug = input.agentSlug.trim();
  }
  // A gap is born open — the lifecycle is create(open) → resolveGapEntry.
  if (kind === 'gap') data.status = 'open';
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

export type UpdateJournalInput = Partial<
  Pick<CreateJournalInput, 'body' | 'title' | 'kind' | 'entryDate' | 'tags'>
>;

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
  // kind/entry_date are cleared when an empty string is passed. Changing kind
  // away from 'gap' drops the gap lifecycle fields; changing TO 'gap' opens it.
  if (input.kind !== undefined) {
    const k = input.kind.trim();
    const wasGap = oldData.kind === 'gap';
    if (k) newData.kind = k;
    else delete newData.kind;
    if (k === 'gap' && !wasGap) {
      newData.status = 'open';
    } else if (k !== 'gap' && wasGap) {
      delete newData.status;
      delete newData.resolved_at;
    }
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
  // A body change invalidates the extractor's prior summary/embedding. Kind /
  // status / date are metadata only — they don't trigger re-extraction (the
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

export type ResolveGapInput = {
  /** The user's answer — becomes a new user-lane entry. */
  answer: string;
  /** Kind for the answer entry; defaults to 'context'. */
  answerKind?: string;
  /** Provenance of the RECORDING (who filed the answer): the agent that heard
   *  it in chat, or 'user' when answered in the UI. The knowledge itself is
   *  the user's either way. */
  author?: 'user' | 'agent';
  agentSlug?: string;
};

/** Close one open question. Two writes: the gap entry gets status='resolved'
 *  (+resolved_at, audit trail kept), and the answer lands as a NEW user-lane
 *  entry so it flows into the "# About the user" block and the index. Returns
 *  null when the id isn't an owner-held gap entry. */
export async function resolveGapEntry(
  ownerId: string,
  id: string,
  input: ResolveGapInput,
): Promise<{ gap: JournalRow; answer: JournalRow } | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')))
    .limit(1);
  if (!node) return null;
  const d = (node.data ?? {}) as Record<string, unknown>;
  if (d.kind !== 'gap') return null;
  const answerBody = (input.answer ?? '').trim();
  if (!answerBody) throw new Error('answer is required to resolve a gap');
  const answerKind = input.answerKind?.trim() || 'context';

  // Write the answer FIRST. If marking the gap resolved then fails, the gap
  // stays open and the next attempt simply answers it again; the old order
  // could leave a gap marked resolved with no answer behind it (2026-09-02
  // audit, sloppiness A10).
  const answer = await createJournal(ownerId, {
    body: answerBody,
    kind: answerKind,
    author: input.author,
    agentSlug: input.agentSlug,
  });
  const newData: Record<string, unknown> = {
    ...d,
    status: 'resolved',
    resolved_at: new Date().toISOString(),
    answer_id: answer.id,
  };
  const [updated] = await db
    .update(nodes)
    .set({ data: newData, updatedAt: new Date() })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('resolveGapEntry: update returned no row');
  return { gap: rowOf(updated), answer };
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
