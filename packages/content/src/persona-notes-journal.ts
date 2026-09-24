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
 *   apply: that exact plan becomes Journal entries. No second sorting run,
 *     so what is applied is what was reviewed (each new entry is indexed,
 *     which runs the extractor). Idempotent: an entry that already carries a
 *     note's ref is skipped; a note retired since the dry run is not brought
 *     back. The persona notes are NOT touched; the agent reads them until
 *     `memory_config.notes_target = 'journal'`, which also switches its
 *     Journal tiers live.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { dedupeNewNotes, type PersonaNote } from '@mantle/db';
import { createJournal, journalKindSql } from './journal';
import { TIER1_MAX_CHARS, journalVisibleSql } from './identity-context';
import {
  applyRetires,
  loadLearnedRules,
  pairNewWithExisting,
  pairRetires,
  type LearnedRule,
  type RulePairScore,
  type RuleReconcileReport,
  type RuleReconciler,
  type RuleRetire,
} from './rule-reconcile';

/** Key of the plan inside the review page's `nodes.data`. */
export const PLAN_DATA_KEY = 'persona_notes_plan';

/**
 * Pure: the JSON object in a model reply, parsed leniently. Prose around the
 * object is ignored, and a bare `N12` / `P3` KEY (models drop the quotes) is
 * quoted. Only keys: the same token inside a string value ("triage of P1
 * incidents") is text and stays as it is.
 */
export function parseLooseJson(text: string): Record<string, unknown> {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error(`no JSON in model reply: ${text.slice(0, 200)}`);
  const body = text.slice(a, b + 1);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return JSON.parse(body.replace(/([{,]\s*)([NP]\d+)(\s*:)/g, '$1"$2"$3')) as Record<
      string,
      unknown
    >;
  }
}

/** What the classifier says about one note. */
export type NoteClass = {
  kind: 'preference' | 'identity' | 'context' | 'expectation' | 'lesson';
  scope: 'general' | 'topic';
  topic: string;
};

const NOTE_CLASS_KINDS: readonly NoteClass['kind'][] = [
  'preference',
  'identity',
  'context',
  'expectation',
  'lesson',
];

/** Pure: a classifier answer, checked. Case and spacing are forgiven
 *  ("Topic", " lesson "); anything else is no answer, so the note is counted
 *  as unsorted instead of landing in a kind nobody reviews. */
export function parseNoteClass(raw: unknown): NoteClass | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const kind = norm(r.kind) as NoteClass['kind'];
  const scope = norm(r.scope);
  if (!NOTE_CLASS_KINDS.includes(kind) || (scope !== 'general' && scope !== 'topic')) return null;
  const topic = typeof r.topic === 'string' ? r.topic.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return { kind, scope, topic };
}

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
  /** Set when this note is a near-copy of another: not created. */
  duplicateOf?: string;
  /** The classifier gave no usable answer: placed by the fallback below. */
  unsorted?: true;
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
 * An unsorted note (no class) goes per turn: always-on is the costly tier,
 * and the review page lists it for the owner to move.
 */
export function journalKindFor(
  noteKind: string,
  cls: NoteClass | undefined,
): { kind: string; scope: 'general' | 'topic' } {
  const scope = noteKind === 'correction' ? 'general' : (cls?.scope ?? 'topic');
  const k = cls?.kind ?? 'expectation';
  if (scope === 'general') {
    return { kind: k === 'identity' || k === 'context' ? 'identity' : 'preference', scope };
  }
  if (k === 'context') return { kind: 'context', scope };
  if (k === 'lesson') return { kind: 'lesson', scope };
  return { kind: 'expectation', scope };
}

/**
 * Pure: resolve "same" pairs into duplicates. Pairs are unioned into groups;
 * each group keeps its STRONGEST note (lowest `rank`: a correction before a
 * general note before a topic note), the earliest on a tie, and the rest
 * point at it. Keeping the earliest regardless dropped a later correction and
 * sent its rule to the per-turn tier. Returns ref → the ref it duplicates.
 */
export function duplicateMap(
  orderedRefs: readonly string[],
  samePairs: ReadonlyArray<readonly [string, string]>,
  rank: (ref: string) => number = () => 0,
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
    // The stronger note (then the earlier) is the root of the merged group.
    const aFirst = rank(ra) !== rank(rb) ? rank(ra) < rank(rb) : order.get(ra)! <= order.get(rb)!;
    if (aFirst) parent.set(rb, ra);
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
  const placed = new Map(
    input.notes.map((n) => [n.ref, journalKindFor(n.kind, input.classes.get(n.ref))]),
  );
  const kindOf = new Map(input.notes.map((n) => [n.ref, n.kind]));
  const dups = duplicateMap(
    input.notes.map((n) => n.ref),
    input.samePairs,
    (ref) => (kindOf.get(ref) === 'correction' ? 0 : placed.get(ref)?.scope === 'general' ? 1 : 2),
  );
  const entries: PlanEntry[] = input.notes.map((n) => {
    const cls = input.classes.get(n.ref);
    const { kind, scope } = placed.get(n.ref)!;
    const duplicateOf = dups.get(n.ref);
    return {
      ref: n.ref,
      content: n.content,
      noteKind: n.kind,
      kind,
      scope,
      topic: cls?.topic ?? '',
      ...(duplicateOf ? { duplicateOf } : {}),
      ...(cls ? {} : { unsorted: true as const }),
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
  const unsorted = kept.filter((e) => e.unsorted);
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
    `| Unsorted (no usable answer; placed per turn) | ${unsorted.length} | ${chars(unsorted)} |`,
    '',
    `Sorted by \`${plan.model}\` on ${plan.createdAt.slice(0, 10)}.`,
    '',
    ...(chars(general) > TIER1_MAX_CHARS
      ? [
          `:::warning`,
          `The always-on notes come to ${chars(general)} chars; the always-on tier holds ${TIER1_MAX_CHARS}, shared with the user's own identity, goal and preference entries. What does not fit is picked per turn like a topic note: by the decider when its journal_recall use is on, otherwise by similarity, which rarely matches a standing rule. Turn journal_recall on before switching this agent, or move notes that must always apply into fewer, shorter entries.`,
          `:::`,
          '',
        ]
      : []),
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
    ...(unsorted.length
      ? [
          '## Unsorted',
          '',
          'The model gave no usable answer for these; they are placed per turn. Edit the entry kind in the Journal after applying if one must always apply.',
          '',
          '| Note |',
          '|---|',
          ...unsorted.map((e) => `| ${esc(e.content)} |`),
          '',
        ]
      : []),
    '## Duplicates (merged into the note kept)',
    '',
    '| Dropped | Kept |',
    '|---|---|',
    ...dups.map(
      (e) => `| ${esc(e.content)} | ${esc(byRef.get(e.duplicateOf!)?.content ?? e.duplicateOf!)} |`,
    ),
  ];
  return lines.join('\n');
}

/** Tag on every converted entry, so they can be found as a set. */
export const CONVERTED_TAG = 'from-persona-notes';

/**
 * Pure: the plan stored on a review page, checked before it writes anything.
 * The page's `data` is only as trustworthy as whatever last wrote it, so a
 * wrong shape is an error that names the problem, never a partial apply.
 */
export function parseConversionPlan(raw: unknown): ConversionPlan {
  const fail = (why: string): never => {
    throw new Error(`the review page's plan is not usable: ${why}`);
  };
  if (!raw || typeof raw !== 'object') fail('missing');
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) fail(`version ${String(p.version)} (expected 1)`);
  if (typeof p.agentSlug !== 'string' || !p.agentSlug) fail('no agentSlug');
  if (typeof p.agentId !== 'string' || !p.agentId) fail('no agentId');
  if (!Array.isArray(p.entries)) fail('no entries');
  const kinds = ['identity', 'goal', 'preference', 'context', 'expectation', 'lesson'];
  (p.entries as unknown[]).forEach((e, i) => {
    const x = (e ?? {}) as Record<string, unknown>;
    if (typeof x.ref !== 'string' || !x.ref) fail(`entry ${i}: no ref`);
    if (typeof x.content !== 'string' || !x.content.trim()) fail(`entry ${i}: no content`);
    if (typeof x.kind !== 'string' || !kinds.includes(x.kind))
      fail(`entry ${i}: kind ${String(x.kind)}`);
    if (x.scope !== 'general' && x.scope !== 'topic') fail(`entry ${i}: scope ${String(x.scope)}`);
  });
  return raw as ConversionPlan;
}

/** Pure: how the agent's live notes moved since the dry run. `retired`: in
 *  the plan but no longer live (the owner or the agent retired them), so
 *  applying must not bring them back. `added`: live now but not in the plan
 *  (learned since), so they would be left behind; re-run the dry run. */
export function planStaleness(
  plan: ConversionPlan,
  liveRefs: ReadonlySet<string>,
): { retired: string[]; added: string[] } {
  const planned = new Set(plan.entries.map((e) => e.ref));
  return {
    retired: plan.entries.filter((e) => !liveRefs.has(e.ref)).map((e) => e.ref),
    added: [...liveRefs].filter((r) => !planned.has(r)),
  };
}

/**
 * Create the plan's Journal entries (duplicates and `skipRefs` skipped).
 * Idempotent: an entry whose `data.source.persona_note_ref` matches is not
 * created again. Authored as the agent (`author: 'agent'`, `agent_slug`), so
 * the entry belongs to that agent (visibleToAgent). Each insert is indexed
 * like any Journal write, which runs the extractor once per entry: an apply
 * makes no model call itself, but it does spend.
 */
export async function applyConversionPlan(
  ownerId: string,
  plan: ConversionPlan,
  opts: { skipRefs?: ReadonlySet<string> } = {},
): Promise<{ created: number; existing: number; duplicates: number; skipped: number }> {
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
  let skipped = 0;
  // A group whose kept note was retired since the dry run (the owner kept a
  // different copy by hand) is re-rooted on its first live duplicate, so the
  // rule is not lost with the retired copy.
  const rerooted = new Set<string>();
  const byRef = new Map(plan.entries.map((x) => [x.ref, x]));
  for (const e of plan.entries) {
    // A substitute takes the kind of the note it replaces: the group's rule
    // was reviewed as that (a correction stays always on).
    let kind = e.kind;
    if (e.duplicateOf) {
      const rootGone = opts.skipRefs?.has(e.duplicateOf) === true;
      if (!rootGone || rerooted.has(e.duplicateOf) || opts.skipRefs?.has(e.ref)) {
        duplicates++;
        continue;
      }
      rerooted.add(e.duplicateOf);
      kind = byRef.get(e.duplicateOf)?.kind ?? e.kind;
    }
    if (opts.skipRefs?.has(e.ref)) {
      skipped++;
      continue;
    }
    if (done.has(e.ref)) {
      existing++;
      continue;
    }
    await createJournal(ownerId, {
      body: e.content,
      kind,
      author: 'agent',
      agentSlug: plan.agentSlug,
      tags: [CONVERTED_TAG],
      source: { persona_note_ref: e.ref, agent_slug: plan.agentSlug, topic: e.topic },
    });
    // Two notes can share a ref (id-less notes with the same text): one entry.
    done.add(e.ref);
    created++;
  }
  return { created, existing, duplicates, skipped };
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

export type LearnedWrite = {
  written: Array<{ id: string; kind: string; content: string }>;
  /** Null when no reconciler was given, the agent has no close rules, or the
   *  decider did not answer. */
  reconcile: RuleReconcileReport | null;
};

/**
 * Write notes an agent learned (reflector, update_persona) as Journal
 * entries authored by that agent.
 *
 * With a `reconcile` wired in (the decider's `rule_reconcile` use), each new
 * rule is paired with the agent's close existing learned rules. Live: when a
 * pair clears the gate (same rule, or the new rule changes the old one), the
 * new rule is written and the OLDER one is superseded by it. Shadow: nothing
 * changes and the would-be retires come back in `reconcile`.
 *
 * The reflector's notes still pass the token-Jaccard backstop (dropped when
 * they near-copy an entry the agent already knows), except, in live mode, a
 * note the decider matched: it replaces the old rule instead of being
 * dropped, so a correction ("British spelling" → "American spelling"), which
 * the backstop reads as a copy, lands. An update_persona note is an explicit
 * request and is always written.
 */
export async function writeLearnedEntries(
  ownerId: string,
  agentSlug: string,
  notes: ReadonlyArray<{ kind: string; content: string; scope?: 'general' | 'topic' | null }>,
  via: 'reflector' | 'update_persona',
  opts: { reconcile?: RuleReconciler } = {},
): Promise<LearnedWrite> {
  const incoming = notes.filter((n) => n.content.trim().length > 0);
  const judged = opts.reconcile
    ? await judgeNewRules(
        ownerId,
        agentSlug,
        incoming.map((n) => n.content.trim()),
        opts.reconcile,
      )
    : null;
  const live = judged?.judgement.mode === 'live';
  const matched = new Set<number>();
  judged?.pairs.forEach((p, k) => {
    if (pairRetires(judged.judgement.scores[k] ?? null, judged.judgement.threshold)) {
      matched.add(p.newIdx);
    }
  });

  let keep = incoming.map((_, i) => i);
  if (via === 'reflector') {
    const known = await knownJournalEntries(ownerId, agentSlug);
    const asNotes: PersonaNote[] = known.map((e) => ({ kind: 'style', content: e.body, at: '' }));
    const backstop = keep.filter((i) => !(live && matched.has(i)));
    const passed = new Set(
      dedupeNewNotes(
        asNotes,
        backstop.map((i) => ({ i, content: incoming[i]!.content })),
      ).map((x) => x.i),
    );
    keep = keep.filter((i) => (live && matched.has(i)) || passed.has(i));
  }

  const written: LearnedWrite['written'] = [];
  const idOf = new Map<number, string>();
  for (const i of keep) {
    const n = incoming[i]!;
    const kind = journalKindForNote(n.kind, n.scope ?? null);
    const row = await createJournal(ownerId, {
      body: n.content.trim(),
      kind,
      author: 'agent',
      agentSlug,
      tags: [via === 'reflector' ? 'reflector' : 'update-persona'],
      source: { via, agent_slug: agentSlug, note_kind: n.kind },
    });
    idOf.set(i, row.id);
    written.push({ id: row.id, kind, content: n.content.trim() });
  }

  if (!judged) return { written, reconcile: null };
  const { judgement, pairs, rules } = judged;
  // Each older rule goes once, to the new rule it matched best. A new rule
  // the backstop dropped (shadow) retires nothing: it was not written.
  const best = new Map<number, { newIdx: number; score: RulePairScore }>();
  pairs.forEach((p, k) => {
    const score = judgement.scores[k] ?? null;
    if (!pairRetires(score, judgement.threshold)) return;
    if (!idOf.has(p.newIdx)) return;
    const cur = best.get(p.ruleIdx);
    const strength = Math.max(score!.same, score!.replaces);
    if (!cur || strength > Math.max(cur.score.same, cur.score.replaces)) {
      best.set(p.ruleIdx, { newIdx: p.newIdx, score: score! });
    }
  });
  const retires: RuleRetire[] = [...best.entries()].map(([ruleIdx, { newIdx, score }]) => ({
    olderId: rules[ruleIdx]!.id,
    newerId: idOf.get(newIdx)!,
    older: rules[ruleIdx]!.body,
    newer: incoming[newIdx]!.content.trim(),
    same: Math.round(score.same * 100) / 100,
    replaces: Math.round(score.replaces * 100) / 100,
  }));
  const errors = live ? await applyRetires(ownerId, retires, judgement.threshold) : 0;
  return {
    written,
    reconcile: {
      mode: judgement.mode,
      threshold: judgement.threshold,
      pairs: pairs.length,
      calls: judgement.calls,
      failed: judgement.failed,
      ms: judgement.ms,
      retires,
      errors,
    },
  };
}

/** Pair new rule texts with the agent's close learned rules and ask the
 *  decider. Null when there is nothing to ask or no answer; never throws (a
 *  failed reconcile must not stop the write). */
async function judgeNewRules(
  ownerId: string,
  agentSlug: string,
  texts: string[],
  reconciler: RuleReconciler,
): Promise<{
  judgement: NonNullable<Awaited<ReturnType<RuleReconciler['judge']>>>;
  pairs: Array<{ newIdx: number; ruleIdx: number; sim: number }>;
  rules: LearnedRule[];
} | null> {
  if (texts.length === 0) return null;
  try {
    const rules = await loadLearnedRules(ownerId, agentSlug);
    if (rules.length === 0) return null;
    const vecs = await reconciler.embed([...texts, ...rules.map((r) => r.body)]);
    const pairs = pairNewWithExisting(
      vecs.slice(0, texts.length),
      vecs.slice(texts.length),
      reconciler.similarityFloor,
    );
    if (pairs.length === 0) return null;
    const judgement = await reconciler.judge(
      pairs.map((p) => ({ older: rules[p.ruleIdx]!.body, newer: texts[p.newIdx]! })),
    );
    return judgement ? { judgement, pairs, rules } : null;
  } catch (err) {
    console.warn(
      `[rule-reconcile] ${agentSlug}: skipped (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}
