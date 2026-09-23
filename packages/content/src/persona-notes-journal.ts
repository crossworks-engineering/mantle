/**
 * Persona notes → Journal: the one-time conversion (spike 13, dev-brain page
 * 9f57fa46). Persona notes and the Journal's agent lane hold the same thing,
 * what an agent learned about helping its user, but the notes ride every
 * prompt in full and are never retired (a work brain: 503 notes, 103k chars), while
 * the Journal picks per turn (tiers, journal_recall) and can be edited.
 *
 * Two runs, one plan (the maintenance task `persona-notes-to-journal`):
 *   dry run: a model sorts each note (kind, general/topic), near-copies are
 *     merged, and the plan is written to a review PAGE (markdown for the
 *     owner, the plan itself in the page's `data`);
 *   apply: that exact plan becomes Journal entries. No second model run, so
 *     what is applied is what was reviewed. Idempotent: an entry that already
 *     carries a note's ref is skipped. The persona notes are NOT touched; the
 *     agent reads them until `memory_config.notes_target` says otherwise.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { dedupeNewNotes, type PersonaNote } from '@mantle/db';
import { createJournal, journalKindSql } from './journal';
import { journalVisibleSql } from './identity-context';

/** Key of the plan inside the review page's `nodes.data`. */
export const PLAN_DATA_KEY = 'persona_notes_plan';

/** What the classifier says about one note. */
export type NoteClass = {
  kind: 'preference' | 'identity' | 'context' | 'expectation' | 'lesson';
  scope: 'general' | 'topic';
  topic: string;
};

export type PlanEntry = {
  /** The persona note's ref (noteRef: id, or a content hash). */
  ref: string;
  content: string;
  /** The note's own kind (style / relationship / correction). */
  noteKind: string;
  /** The Journal kind the entry gets. */
  kind: string;
  scope: 'general' | 'topic';
  topic: string;
  /** Set when this note is a near-copy of an earlier one: not created. */
  duplicateOf?: string;
};

export type ConversionPlan = {
  version: 1;
  agentId: string;
  agentSlug: string;
  createdAt: string;
  model: string;
  entries: PlanEntry[];
};

/**
 * Pure: the Journal kind for a classified note. General notes must land in a
 * tier 1 kind (always on): identity for who-the-user-is and background,
 * preference for everything else. Topic notes land in tier 2: context stays
 * context (user lane), lesson stays lesson, anything else is an expectation
 * (agent lane, picked per turn by journal_recall). A correction is always
 * general: a "not Sarah-with-an-h" must never depend on a relevance pick.
 */
export function journalKindFor(
  noteKind: string,
  cls: NoteClass | undefined,
): { kind: string; scope: 'general' | 'topic' } {
  const scope = noteKind === 'correction' ? 'general' : (cls?.scope ?? 'general');
  const k = cls?.kind ?? 'preference';
  if (scope === 'general') {
    return { kind: k === 'identity' || k === 'context' ? 'identity' : 'preference', scope };
  }
  if (k === 'context') return { kind: 'context', scope };
  if (k === 'lesson') return { kind: 'lesson', scope };
  return { kind: 'expectation', scope };
}

/**
 * Pure: resolve "same" pairs into duplicates. Pairs are unioned into groups;
 * each group keeps its EARLIEST note (the order given) and the rest point at
 * it. Returns ref → the ref it duplicates.
 */
export function duplicateMap(
  orderedRefs: readonly string[],
  samePairs: ReadonlyArray<readonly [string, string]>,
): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const order = new Map(orderedRefs.map((r, i) => [r, i]));
  for (const [a, b] of samePairs) {
    if (!order.has(a) || !order.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    // The earlier note is the root of the merged group.
    if (order.get(ra)! <= order.get(rb)!) parent.set(rb, ra);
    else parent.set(ra, rb);
  }
  const out = new Map<string, string>();
  for (const r of orderedRefs) {
    const root = find(r);
    if (root !== r) out.set(r, root);
  }
  return out;
}

/** Pure: assemble the plan from the notes (oldest first), their classes and
 *  the confirmed same-pairs. */
export function buildConversionPlan(input: {
  agentId: string;
  agentSlug: string;
  model: string;
  notes: ReadonlyArray<{ ref: string; kind: string; content: string }>;
  classes: ReadonlyMap<string, NoteClass>;
  samePairs: ReadonlyArray<readonly [string, string]>;
  now?: Date;
}): ConversionPlan {
  const dups = duplicateMap(
    input.notes.map((n) => n.ref),
    input.samePairs,
  );
  const entries: PlanEntry[] = input.notes.map((n) => {
    const cls = input.classes.get(n.ref);
    const { kind, scope } = journalKindFor(n.kind, cls);
    const duplicateOf = dups.get(n.ref);
    return {
      ref: n.ref,
      content: n.content,
      noteKind: n.kind,
      kind,
      scope,
      topic: cls?.topic ?? '',
      ...(duplicateOf ? { duplicateOf } : {}),
    };
  });
  return {
    version: 1,
    agentId: input.agentId,
    agentSlug: input.agentSlug,
    createdAt: (input.now ?? new Date()).toISOString(),
    model: input.model,
    entries,
  };
}

/** Pure: the review page body. */
export function renderConversionPlanMarkdown(plan: ConversionPlan, applyCommand: string): string {
  const kept = plan.entries.filter((e) => !e.duplicateOf);
  const general = kept.filter((e) => e.scope === 'general');
  const topic = kept.filter((e) => e.scope === 'topic');
  const dups = plan.entries.filter((e) => e.duplicateOf);
  const chars = (es: PlanEntry[]) => es.reduce((n, e) => n + e.content.length, 0);
  const byRef = new Map(plan.entries.map((e) => [e.ref, e]));
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

  const lines: string[] = [
    `:::info`,
    `Dry run: nothing has changed. Review the ${plan.entries.length} persona notes of agent \`${plan.agentSlug}\` below as they would become Journal entries. To apply exactly this plan: \`${applyCommand}\`. The persona notes stay as they are until the agent's \`memory_config.notes_target\` is set to \`journal\`.`,
    `:::`,
    '',
    '## Summary',
    '',
    '| | Notes | Chars |',
    '|---|---|---|',
    `| Today: every note on every turn | ${plan.entries.length} | ${chars(plan.entries)} |`,
    `| Always on (tier 1: identity, preference) | ${general.length} | ${chars(general)} |`,
    `| Per turn, only when relevant (tier 2) | ${topic.length} | ${chars(topic)} |`,
    `| Duplicates, not created | ${dups.length} | ${chars(dups)} |`,
    '',
    `Sorted by \`${plan.model}\` on ${plan.createdAt.slice(0, 10)}.`,
    '',
    '## Always on',
    '',
    '| Kind | Note |',
    '|---|---|',
    ...general.map((e) => `| ${e.kind} | ${esc(e.content)} |`),
    '',
    '## Per turn, by topic',
    '',
    '| Topic | Kind | Note |',
    '|---|---|---|',
    ...[...topic]
      .sort((a, b) => a.topic.localeCompare(b.topic))
      .map((e) => `| ${esc(e.topic)} | ${e.kind} | ${esc(e.content)} |`),
    '',
    '## Duplicates (merged into the earlier note)',
    '',
    '| Dropped | Kept |',
    '|---|---|',
    ...dups.map(
      (e) => `| ${esc(e.content)} | ${esc(byRef.get(e.duplicateOf!)?.content ?? e.duplicateOf!)} |`,
    ),
  ];
  return lines.join('\n');
}

/** Tag on every converted entry, so they can be found (and undone) as a set. */
export const CONVERTED_TAG = 'from-persona-notes';

/**
 * Create the plan's Journal entries (duplicates skipped). Idempotent: an
 * entry whose `data.source.persona_note_ref` matches is not created again.
 * Authored as the agent (`author: 'agent'`, `agent_slug`), so the Journal
 * shows who learned it. Each insert is indexed like any Journal write.
 */
export async function applyConversionPlan(
  ownerId: string,
  plan: ConversionPlan,
): Promise<{ created: number; existing: number; duplicates: number }> {
  const existingRows = await db
    .select({ ref: sql<string>`${nodes.data}->'source'->>'persona_note_ref'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'journal'),
        sql`${nodes.data}->'source'->>'agent_slug' = ${plan.agentSlug}`,
      ),
    );
  const done = new Set(existingRows.map((r) => r.ref));
  let created = 0;
  let existing = 0;
  let duplicates = 0;
  for (const e of plan.entries) {
    if (e.duplicateOf) {
      duplicates++;
      continue;
    }
    if (done.has(e.ref)) {
      existing++;
      continue;
    }
    await createJournal(ownerId, {
      body: e.content,
      kind: e.kind,
      author: 'agent',
      agentSlug: plan.agentSlug,
      tags: [CONVERTED_TAG],
      source: { persona_note_ref: e.ref, agent_slug: plan.agentSlug, topic: e.topic },
    });
    created++;
  }
  return { created, existing, duplicates };
}

// ─── After the conversion: learning straight into the Journal ───────────────
// memory_config.notes_target = 'journal' (per agent, default 'persona'): the
// agent stops reading its persona notes, and the reflector and update_persona
// write Journal entries instead, so what the agent learns joins the tiers
// (general → tier 1, topic → tier 2 via journal_recall).

export type NotesTarget = 'persona' | 'journal';

/** Where an agent's learned notes live (default: its persona notes). */
export function notesTargetOf(
  memoryConfig: { notes_target?: string } | null | undefined,
): NotesTarget {
  return memoryConfig?.notes_target === 'journal' ? 'journal' : 'persona';
}

/**
 * Pure: the Journal kind for a note learned live. A correction is always on
 * (preference); a relationship note is who-the-user-is (identity); a style
 * note is a preference when it applies to most conversations, an
 * expectation (picked per turn) when it only applies to one topic. No scope
 * given = general: an explicit request is a standing preference.
 */
export function journalKindForNote(noteKind: string, scope?: 'general' | 'topic' | null): string {
  if (noteKind === 'correction') return 'preference';
  if (noteKind === 'relationship') return 'identity';
  return scope === 'topic' ? 'expectation' : 'preference';
}

/** Rules one reflector run is shown as "already known", newest first. */
export const KNOWN_ENTRIES_LIMIT = 300;

/** What this agent already knows from the Journal (body + kind), newest
 *  first: the rule-like kinds it may see (identity, goal, preference, lesson,
 *  expectation), not work logs or gaps, and nothing superseded. The reflector
 *  reads it so it only learns what is new. */
export async function knownJournalEntries(
  ownerId: string,
  agentSlug: string | null,
  limit = KNOWN_ENTRIES_LIMIT,
): Promise<Array<{ kind: string; body: string }>> {
  const rows = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'journal'),
        sql`${journalKindSql()} in ('identity', 'goal', 'preference', 'lesson', 'expectation')`,
        journalVisibleSql(agentSlug),
      ),
    )
    .orderBy(desc(nodes.createdAt), desc(nodes.id))
    .limit(limit);
  return rows
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        kind: typeof d.kind === 'string' ? d.kind : 'context',
        body: typeof d.body === 'string' ? d.body.trim() : '',
      };
    })
    .filter((e) => e.body.length > 0);
}

/**
 * Write notes an agent learned (reflector, update_persona) as Journal
 * entries authored by that agent. The reflector's notes are dropped when they
 * near-copy an entry the agent already knows (the persona path's
 * token-Jaccard backstop). An update_persona note is an explicit request and
 * is always written: the backstop would read a correction ("British spelling"
 * → "American spelling") as a copy and silently keep the old rule. Returns
 * the entries written.
 */
export async function writeLearnedEntries(
  ownerId: string,
  agentSlug: string,
  notes: ReadonlyArray<{ kind: string; content: string; scope?: 'general' | 'topic' | null }>,
  via: 'reflector' | 'update_persona',
): Promise<Array<{ kind: string; content: string }>> {
  let fresh = [...notes];
  if (via === 'reflector') {
    const known = await knownJournalEntries(ownerId, agentSlug);
    const asNotes: PersonaNote[] = known.map((e) => ({ kind: 'style', content: e.body, at: '' }));
    fresh = dedupeNewNotes(asNotes, fresh);
  }
  const written: Array<{ kind: string; content: string }> = [];
  for (const n of fresh) {
    const kind = journalKindForNote(n.kind, n.scope ?? null);
    await createJournal(ownerId, {
      body: n.content.trim(),
      kind,
      author: 'agent',
      agentSlug,
      tags: [via === 'reflector' ? 'reflector' : 'update-persona'],
      source: { via, agent_slug: agentSlug, note_kind: n.kind },
    });
    written.push({ kind, content: n.content.trim() });
  }
  return written;
}
