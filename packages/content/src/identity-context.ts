/**
 * The always-on journal-derived context blocks.
 *
 * Journal entries (./journal.ts) live in two lanes. User-lane entries are the
 * user's own statements about who they are and what they want; this module
 * distils them into a compact "# About the user" block. Agent-lane entries are
 * what agents have learned about doing their job (lessons, expectations) plus
 * the questions they still need answered (open gaps); those distil into a
 * per-turn "# Working notes" block. With `journal_tiers` off or shadow, callers
 * prepend both to the agent's system prompt on every turn; with `live` the
 * tiers below replace them. Either way an agent knows the user AND its own
 * accumulated craft without either being re-explained.
 *
 * Cost-safety (project rule: never add triggers/loops that can run the LLM
 * away): the distillation here is **deterministic** — a bounded, kind-grouped
 * selection of real entries, NO LLM call. The output only changes when an
 * entry is added/edited, so it sits inside the cached system block (same
 * cadence as persona notes) and costs nothing per turn beyond the tokens.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { contentChunks, db, nodes } from '@mantle/db';
import {
  KINDS,
  kindLabel,
  kindLane,
  legacyCategoryToKind,
} from '@mantle/content-core/journal-options';
import { journalKindSql, journalLearnedSql, journalSortSql } from './journal';
import { loadProfilePreferences } from './profile-preferences';
import { purposeArchetypeLabel } from '@mantle/content-core/onboarding-questions';

/** Hard caps so the blocks can never balloon, however many entries exist. */
const MAX_PER_GROUP = 6;
const MAX_TOTAL = 30;
const MAX_ENTRY_CHARS = 280;
/** Open questions shown in the working-notes tail. */
const MAX_OPEN_QUESTIONS = 5;
/** Cap the injected purpose so a runaway paste can't bloat every turn's prompt. */
const MAX_PURPOSE_CHARS = 600;

/** One journal entry, reduced to what the old identity block needs, newest
 *  first (the DB query orders them); within a group that order is kept. */
export type IdentityEntry = { body: string; kind: string | null };
export type WorkingNoteEntry = {
  body: string;
  kind: string | null;
  agentSlug: string | null;
  status: string | null;
};

const USER_KIND_ORDER: readonly string[] = KINDS.filter((k) => k.lane === 'user').map((k) => k.key);

/**
 * Pure renderer: turn the brain's purpose into the `# Purpose of this brain`
 * block. Deterministic and DB-free (unit-tested). Returns '' for a blank
 * purpose. The optional archetype label renders as a "Speciality:" line.
 */
export function renderPurposeBlock(purpose: string, archetypeLabel: string | null): string {
  const raw = (purpose ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const p =
    raw.length > MAX_PURPOSE_CHARS ? `${raw.slice(0, MAX_PURPOSE_CHARS - 1).trimEnd()}…` : raw;
  const lines: string[] = [
    'What this brain is configured for. Treat it as the brain’s mission — what it',
    'exists to help with — and let it shape what you prioritise, what you pay',
    'attention to, and the tone you take. Do not recite it back unprompted.',
  ];
  if (archetypeLabel) lines.push('', `**Speciality:** ${archetypeLabel}`);
  lines.push('', p);
  return `# Purpose of this brain\n\n${lines.join('\n')}`;
}

function cleanBody(body: string): string {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ENTRY_CHARS ? `${flat.slice(0, MAX_ENTRY_CHARS - 1).trimEnd()}…` : flat;
}

/**
 * Pure renderer: turn user-lane journal entries into the `# About the user`
 * block. Deterministic and DB-free (unit-tested). Returns '' when nothing
 * renders.
 *
 * Rules: bodies are whitespace-collapsed + truncated to MAX_ENTRY_CHARS;
 * grouped by kind in the canonical user-lane order (unknown/blank kinds →
 * trailing "Other"); ≤ MAX_PER_GROUP entries per group and ≤ MAX_TOTAL
 * overall; empty-body entries are skipped.
 */
export function renderIdentityBlock(entries: IdentityEntry[]): string {
  const UNCAT = '__other__';
  const byKind = new Map<string, string[]>();
  for (const e of entries) {
    const body = cleanBody(e.body);
    if (!body) continue;
    const kind = typeof e.kind === 'string' && e.kind.trim() ? e.kind.trim() : null;
    const key = kind && USER_KIND_ORDER.includes(kind) ? kind : UNCAT;
    const list = byKind.get(key) ?? [];
    if (list.length < MAX_PER_GROUP) list.push(body);
    byKind.set(key, list);
  }

  const orderedKeys = [...USER_KIND_ORDER, UNCAT].filter((k) => byKind.has(k));

  const lines: string[] = [
    'The following is what the user has recorded about who they are, what they',
    'do, and what they expect (their "Journal"). Treat it as durable,',
    'first-person truth about the user. Use it to ground who you are talking',
    'to; do not recite it back unprompted.',
  ];
  let total = 0;
  for (const key of orderedKeys) {
    if (total >= MAX_TOTAL) break;
    const list = byKind.get(key)!;
    const heading = key === UNCAT ? 'Other' : (kindLabel(key) ?? key);
    const bullets: string[] = [];
    for (const body of list) {
      if (total >= MAX_TOTAL) break;
      bullets.push(`- ${body}`);
      total++;
    }
    if (bullets.length) {
      lines.push('', `## ${heading}`, ...bullets);
    }
  }

  if (total === 0) return '';

  return `# About the user (Journal)\n\n${lines.join('\n')}`;
}

/**
 * Pure renderer: turn agent-lane journal entries into the `# Working notes`
 * block for ONE agent's turn. Deterministic and DB-free (unit-tested).
 * Returns '' when nothing renders.
 *
 * An agent sees its own lessons and expectations plus those no agent owns
 * (2026-09-23: persona notes, which were per agent, moved into the Journal).
 * Open gaps stay brain-wide and render as an "Open questions" tail,
 * attributed when another agent raised them, so the agent knows what the
 * brain is missing and can ask when it fits the conversation.
 */
export function renderWorkingNotesBlock(
  entries: WorkingNoteEntry[],
  currentAgentSlug?: string | null,
): string {
  const expectations: string[] = [];
  const lessons: string[] = [];
  const openQuestions: string[] = [];

  for (const e of entries) {
    const body = cleanBody(e.body);
    if (!body) continue;
    const kind = typeof e.kind === 'string' ? e.kind.trim() : '';
    const slug = typeof e.agentSlug === 'string' && e.agentSlug.trim() ? e.agentSlug.trim() : null;
    const attribution = slug && slug !== currentAgentSlug ? ` _(learned by ${slug})_` : '';
    if (kind === 'expectation' && expectations.length < MAX_PER_GROUP) {
      expectations.push(`- ${body}${attribution}`);
    } else if (kind === 'lesson' && lessons.length < MAX_PER_GROUP) {
      lessons.push(`- ${body}${attribution}`);
    } else if (
      kind === 'gap' &&
      e.status !== 'resolved' &&
      openQuestions.length < MAX_OPEN_QUESTIONS
    ) {
      openQuestions.push(`- ${body}${attribution}`);
    }
  }

  if (expectations.length + lessons.length + openQuestions.length === 0) return '';

  const lines: string[] = [
    'What the agents of this brain have learned about doing their job well —',
    'standards the user holds them to, lessons from real outcomes, and open',
    'questions the brain still needs answered. Treat it as your own working',
    'knowledge. Do not recite it back unprompted.',
  ];
  if (expectations.length) lines.push('', '## Expectations', ...expectations);
  if (lessons.length) lines.push('', '## Lessons', ...lessons);
  if (openQuestions.length) {
    lines.push(
      '',
      '## Open questions',
      'The brain is missing this knowledge. If one of these is RELEVANT to the',
      'current conversation, ask the user — at most one per turn, never as an',
      'opener, and drop it if the user declines. When the user answers (asked or',
      'volunteered), record it with `journal_resolve_gap` so it is never asked',
      'again.',
      ...openQuestions,
    );
  }

  return `# Working notes (Journal)\n\n${lines.join('\n')}`;
}

/**
 * Build the identity context block for an owner: the brain's purpose (from
 * profile preferences) followed by the "About the user" block distilled from
 * the Journal's user lane. Returns '' when neither is set (so the caller's
 * concat is a clean no-op). Thin DB wrapper over the pure renderers.
 */
export async function buildIdentityContext(
  ownerId: string,
  currentAgentSlug?: string | null,
): Promise<string> {
  const [prefs, rows] = await Promise.all([
    loadProfilePreferences(ownerId),
    db
      .select({ data: nodes.data })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'journal'),
          journalVisibleSql(currentAgentSlug),
        ),
      )
      .orderBy(journalSortSql())
      .limit(200),
  ]);

  const purposeBlock = renderPurposeBlock(
    prefs.purpose ?? '',
    purposeArchetypeLabel(prefs.purposeArchetype),
  );

  const entries: IdentityEntry[] = [];
  for (const r of rows) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const rawKind = typeof d.kind === 'string' && d.kind.trim() ? d.kind.trim() : null;
    // Agent-lane kinds belong to the working-notes block, not here.
    if (rawKind === 'lesson' || rawKind === 'expectation' || rawKind === 'gap') continue;
    entries.push({
      body: typeof d.body === 'string' ? d.body : '',
      // Legacy rows (no kind) map their old category so they keep rendering.
      kind: rawKind ?? legacyKind(d),
    });
  }
  const journalBlock = renderIdentityBlock(entries);

  return [purposeBlock, journalBlock].filter(Boolean).join('\n\n');
}

/**
 * Build the per-agent "# Working notes" block: the agent's own and unowned
 * agent-lane entries (lessons, expectations) plus open gap questions, newest
 * first. Returns ''
 * when there are none. Deterministic, no LLM — same cost posture as
 * `buildIdentityContext`.
 */
export async function buildWorkingNotesContext(
  ownerId: string,
  currentAgentSlug?: string | null,
): Promise<string> {
  const rows = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'journal'),
        sql`${nodes.data}->>'kind' in ('lesson', 'expectation', 'gap')`,
        journalVisibleSql(currentAgentSlug),
      ),
    )
    .orderBy(journalSortSql())
    .limit(200);

  const entries: WorkingNoteEntry[] = rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      body: typeof d.body === 'string' ? d.body : '',
      kind: typeof d.kind === 'string' ? d.kind : null,
      agentSlug: typeof d.agent_slug === 'string' ? d.agent_slug : null,
      status: typeof d.status === 'string' ? d.status : null,
    };
  });
  return renderWorkingNotesBlock(entries, currentAgentSlug ?? null);
}

// ─── Journal tiers (spike 10, dev-brain page 60a2f51e) ───────────────────────
// The two blocks above sit at the FRONT of the cached prompt with newest-first
// caps: a work brain showed six cut-off release notes as "About the user", a
// personal brain silently lost its background entries, and every Journal
// write re-bills the whole cached prefix. The tiers replace them (per agent,
// `memory_config.journal_tiers = 'live'`, implied by `notes_target =
// 'journal'`):
//   Tier 1, always on: purpose + identity / goal / preference, full text,
//     oldest first, in the cached notes block AFTER the persona prompt. Each
//     kind has a share of the budget; what does not fit overflows to tier 2.
//   Tier 2, per turn: context entries, agent lessons / expectations and tier 1
//     overflow that match the message (Jev's score for rules when
//     `journal_recall` is live, else the embedding), the matching passage
//     only, inside a character budget.
//   Tier 3, per turn: at most one open gap question, only when it matches.
// Tiers 2 and 3 ride an uncached block, so a Journal write busts nothing.
//
// Scope: an entry an agent learned (`agent_slug` set) belongs to that agent;
// entries with no agent and open gaps are brain-wide. Superseded entries
// (`nodes.superseded_by`) and entries marked wrong without a replacement (a
// bare `corrected` mark) never show: journalLiveSql.

/** Kinds that are always on (tier 1). */
export const TIER1_KINDS: readonly string[] = ['identity', 'goal', 'preference'];
/** Tier 1 keeps full text, but a runaway paste still cannot bloat every turn. */
const TIER1_MAX_ENTRY_CHARS = 1_500;
/** ~4k tokens, in a cached block. Sized so an owner assistant's standing
 *  rules fit after the persona-notes move (one work brain: 76 general notes,
 *  12.4k chars); persona notes put all 103k chars on every turn before. */
export const TIER1_MAX_CHARS = 16_000;
/** Each kind's first claim on the tier 1 budget; the rest is shared after. A
 *  long identity group can no longer starve every preference (one work brain:
 *  49 identity entries filled a single shared budget). */
const TIER1_SHARES: Readonly<Record<string, number>> = {
  identity: 4_000,
  goal: 2_000,
  preference: 10_000,
};
/** Cosine similarity an entry needs to join a turn. Spike 10: ~0.60 on long
 *  work logs, 0.72 to 0.75 on short personal entries (same embedder). */
export const JOURNAL_RELEVANCE_MIN_DEFAULT = 0.7;
/** Tier 2 + 3 characters per turn. */
export const JOURNAL_RELEVANT_CHARS_DEFAULT = 3_000;
/** A body longer than this sends its best-matching passage, not the whole. */
const TIER2_PASSAGE_CHARS = 1_200;
const TIER2_MAX_ENTRIES = 6;
/** Agent-lane rules picked by Jev (journal_recall): their own budget. Rules
 *  are short (~200 chars) and a turn needs a median 5, up to 13 (spike 13). */
const TIER2_RULES_MAX_ENTRIES = 25;
const TIER2_RULES_CHARS = 6_000;
/** A pick cut to fit the budget shorter than this is dropped, not sent. */
const MIN_PICK_CHARS = 80;
/** Journal rows one relevance pass reads. A plain scan, not an index walk (a
 *  type filter starves an HNSW walk), so this is a safety cap far above any
 *  real brain rather than a working limit. */
const JOURNAL_SCAN_LIMIT = 5_000;
/** Rules one journal_recall pass scores, newest first (~13 Jev groups per 500). */
const JOURNAL_RULES_LIMIT = 1_000;
/** Near-misses kept for the trace snapshot. */
const TIER2_NEAR_MISSES = 3;

function legacyKind(d: Record<string, unknown>): string {
  const str = (k: string) =>
    typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : null;
  return legacyCategoryToKind(str('category'), str('mood'));
}

/** The effective kind of a journal row's data (legacy rows mapped). */
function effectiveKind(d: Record<string, unknown>): string {
  const raw = typeof d.kind === 'string' && d.kind.trim() ? d.kind.trim() : null;
  return raw ?? legacyKind(d);
}

function agentSlugOf(d: Record<string, unknown>): string | null {
  return typeof d.agent_slug === 'string' && d.agent_slug.trim() ? d.agent_slug.trim() : null;
}

/** Collapse whitespace and cut to `max` chars with an ellipsis. `max` of 1 or
 *  less yields '' (a budget spent to nothing must send nothing). */
function flatten(body: string, max: number): string {
  if (max <= 1) return '';
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Pure: may `currentAgentSlug` see this entry? An agent's own learning is
 *  its own; entries with no agent and open gaps are brain-wide. No current
 *  agent (a caller outside a turn) sees everything. */
export function visibleToAgent(
  e: { kind: string | null; agentSlug: string | null; learned: boolean },
  currentAgentSlug: string | null | undefined,
): boolean {
  if (!currentAgentSlug || !e.learned) return true;
  return !e.agentSlug || e.agentSlug === currentAgentSlug;
}

/** Pure: is this entry a rule an agent learned about doing its job (and so
 *  scoped to that agent)? Lessons and expectations always; any other kind
 *  only when it came from the agent's own learning (the reflector,
 *  update_persona, the persona-notes conversion). What an agent RECORDS for
 *  the user ("I'm vegetarian", a resolved gap's answer) is the user's
 *  knowledge and stays brain-wide, whoever wrote it down. Gaps are
 *  brain-wide. */
export function isLearnedRule(kind: string | null, data: Record<string, unknown>): boolean {
  if (kind === 'gap') return false;
  if (kind === 'lesson' || kind === 'expectation') return true;
  const src = (data.source ?? {}) as Record<string, unknown>;
  return (
    src.via === 'reflector' ||
    src.via === 'update_persona' ||
    // Same test as the SQL twin (`is not null`): the two must agree.
    (src.persona_note_ref !== undefined && src.persona_note_ref !== null)
  );
}

// SQL twin of {@link isLearnedRule}: lives in ./journal (the list filter
// needs it too), re-exported here where the scope rules are.
export { journalLearnedSql } from './journal';

/** SQL twin of {@link visibleToAgent} + {@link isLearnedRule}, plus "not
 *  superseded". Every term is NULL-safe: a NULL "learned" would make `not`
 *  NULL and silently hide a row that is not a rule at all. */
/** SQL: the entry is live. Not superseded by another entry, and not marked
 *  wrong: a bare `corrected` mark (content_supersede with no successor, the
 *  owner saying "this rule is wrong") retires it as well. A bare `version` or
 *  `migrated` mark only down-weights search, as for any node. NULL-safe. */
export function journalLiveSql(): SQL {
  return and(
    isNull(nodes.supersededBy),
    sql`coalesce(${nodes.supersededReason}, '') <> 'corrected'`,
  )!;
}

export function journalVisibleSql(currentAgentSlug: string | null | undefined): SQL {
  const live = journalLiveSql();
  if (!currentAgentSlug) return live;
  const learned = journalLearnedSql();
  return and(
    live,
    sql`(not ${learned}
      or coalesce(btrim(${nodes.data}->>'agent_slug'), '') = ''
      or btrim(${nodes.data}->>'agent_slug') = ${currentAgentSlug})`,
  )!;
}

/** One tier 1 entry. `whole` is false when the body was cut to the entry cap. */
export type Tier1Entry = { nodeId: string; kind: string; body: string; whole: boolean };

export type Tier1Plan = {
  /** Rendered, grouped by kind in TIER1_KINDS order, oldest first in a kind. */
  shown: Tier1Entry[];
  /** Did not fit: tier 2 candidates, picked per turn like any rule. */
  overflow: Tier1Entry[];
  chars: number;
};

/**
 * Pure: which tier 1 entries fit. Each kind first fills its own share
 * (TIER1_SHARES) oldest first, stopping at the first entry that does not fit;
 * then the budget left is shared in kind order, oldest first, skipping what
 * does not fit. Deterministic, and a new entry (the newest) never displaces
 * an older one of its own kind: every older entry is placed before it in
 * both passes. It can displace an older entry of a later kind in pass 2.
 */
export function planJournalTier1(
  entries: ReadonlyArray<{ nodeId: string; kind: string | null; body: string }>,
): Tier1Plan {
  const byKind = new Map<string, Tier1Entry[]>();
  for (const e of entries) {
    const kind = e.kind ?? '';
    if (!TIER1_KINDS.includes(kind)) continue;
    const full = (e.body ?? '').replace(/\s+/g, ' ').trim();
    if (!full) continue;
    const body = flatten(full, TIER1_MAX_ENTRY_CHARS);
    byKind.set(kind, [
      ...(byKind.get(kind) ?? []),
      { nodeId: e.nodeId, kind, body, whole: body === full },
    ]);
  }
  const taken = new Set<Tier1Entry>();
  let chars = 0;
  for (const kind of TIER1_KINDS) {
    let used = 0;
    for (const e of byKind.get(kind) ?? []) {
      if (used + e.body.length > (TIER1_SHARES[kind] ?? 0)) break;
      taken.add(e);
      used += e.body.length;
    }
    chars += used;
  }
  for (const kind of TIER1_KINDS) {
    for (const e of byKind.get(kind) ?? []) {
      if (taken.has(e) || chars + e.body.length > TIER1_MAX_CHARS) continue;
      taken.add(e);
      chars += e.body.length;
    }
  }
  const all = TIER1_KINDS.flatMap((k) => byKind.get(k) ?? []);
  return {
    shown: all.filter((e) => taken.has(e)),
    overflow: all.filter((e) => !taken.has(e)),
    chars,
  };
}

/**
 * Pure renderer: the tier 1 block from a plan. Returns '' when neither the
 * purpose nor any entry renders.
 */
export function renderJournalTier1Block(purposeBlock: string, plan: Tier1Plan): string {
  const lines: string[] = [
    'What the user has recorded about who they are, what they want and how',
    'they like to work (their "Journal"). Treat it as durable, first-person',
    'truth about the user. Do not recite it back unprompted.',
  ];
  for (const kind of TIER1_KINDS) {
    const bullets = plan.shown.filter((e) => e.kind === kind).map((e) => `- ${e.body}`);
    if (bullets.length) lines.push('', `## ${kindLabel(kind) ?? kind}`, ...bullets);
  }
  const journal = plan.shown.length > 0 ? `# About the user (Journal)\n\n${lines.join('\n')}` : '';
  return [purposeBlock, journal].filter(Boolean).join('\n\n');
}

/** Tier 1 candidates for one agent: identity / goal / preference entries it
 *  may see, oldest first (created_at, then id, so the order never shifts on
 *  an edit). The kind filter is in SQL, so a brain full of work logs cannot
 *  push a new identity entry past the row cap. */
export async function loadJournalTier1Entries(
  ownerId: string,
  agentSlug: string | null,
): Promise<Array<{ nodeId: string; kind: string; body: string }>> {
  const rows = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'journal'),
        sql`${journalKindSql()} in ('identity', 'goal', 'preference')`,
        journalVisibleSql(agentSlug),
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .limit(JOURNAL_RULES_LIMIT);
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return { nodeId: r.id, kind: effectiveKind(d), body: typeof d.body === 'string' ? d.body : '' };
  });
}

/**
 * Tier 1 for one agent's turn: the brain's purpose plus the always-on
 * entries that fit. Deterministic, no LLM; it only changes when such an entry
 * or the purpose changes.
 */
export async function buildJournalTier1(
  ownerId: string,
  agentSlug: string | null,
): Promise<string> {
  const [prefs, entries] = await Promise.all([
    loadProfilePreferences(ownerId),
    loadJournalTier1Entries(ownerId, agentSlug),
  ]);
  const purposeBlock = renderPurposeBlock(
    prefs.purpose ?? '',
    purposeArchetypeLabel(prefs.purposeArchetype),
  );
  return renderJournalTier1Block(purposeBlock, planJournalTier1(entries));
}

/** One journal entry picked (or nearly picked) for this turn. */
export type JournalPick = {
  nodeId: string;
  kind: string;
  lane: 'user' | 'agent';
  agentSlug: string | null;
  similarity: number;
  /** What the prompt gets: the whole body, or its best-matching passage. */
  text: string;
  /** True when `text` is a passage of a longer body. */
  passage: boolean;
  /** True when `text` is the complete body (not a passage, not cut). Only a
   *  whole pick makes the entry's facts and search hits redundant. */
  whole: boolean;
  /** Jev's 0-3 score when the pick came from `journal_recall`. */
  score?: number;
};

export type JournalRelevance = {
  picks: JournalPick[];
  gap: JournalPick | null;
  /** Best entries under the cutoff (for the trace), text omitted. */
  nearMisses: Array<Pick<JournalPick, 'nodeId' | 'kind' | 'similarity'>>;
  cutoff: number;
  chars: number;
  /** Why nothing was picked without looking. */
  skipped: 'small_talk' | null;
};

const SMALL_TALK =
  /^(hi|hey|hello|hiya|yo|thanks|thank you|thx|ty|cheers|ok|okay|k|kk|cool|great|nice|perfect|sure|yes|no|yep|yup|nope|got it|sounds good|lol|haha|good (morning|afternoon|evening|night)|morning|evening|night|bye|see you)( (there|again|so much|a lot|mate|all))?$/;

/** Greetings, thanks and acknowledgements: no Journal lookup and no history
 *  recall (spike 10: short test prompts pulled entries at 0.66 to 0.75). A
 *  one-word message is NOT small talk by length alone: "invoices" or
 *  "budget" is a real request. Emoji or punctuation alone is. */
export function isSmallTalk(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!.?,\s]+$/g, '');
  if (!t) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return SMALL_TALK.test(t);
}

export type JournalCandidate = {
  nodeId: string;
  kind: string;
  agentSlug: string | null;
  status: string | null;
  body: string;
  similarity: number;
};

/** Scores from `journal_recall`, by node id. */
export type JournalAgentScores = { scores: ReadonlyMap<string, number>; threshold: number };

/**
 * Pure: choose tier 2 entries and the tier 3 gap from scored candidates.
 * Tier 2 is every non-gap entry not shown in tier 1 (`alwaysOn`; without it,
 * every tier 1 kind is left out). Best similarity first, at or above the
 * cutoff, at most TIER2_MAX_ENTRIES, inside the character budget (the first
 * pick is cut to fit rather than dropped, unless that leaves a stub).
 * `passages` maps a node id to its best-matching passage, used when the body
 * is long.
 *
 * `agentScores` (journal_recall live): entries Jev scored are picked by score
 * (at or above the threshold, best first, their own budget) and never by
 * similarity. An entry Jev did not score (its group failed) falls back to
 * similarity, so a failed group costs nothing a turn without Jev would have.
 */
export function pickJournalEntries(
  candidates: readonly JournalCandidate[],
  opts: {
    cutoff: number;
    budgetChars: number;
    passages?: ReadonlyMap<string, string>;
    agentScores?: JournalAgentScores;
    alwaysOn?: ReadonlySet<string>;
  },
): Pick<JournalRelevance, 'picks' | 'gap' | 'nearMisses' | 'chars'> {
  const sorted = [...candidates].sort(
    (a, b) => b.similarity - a.similarity || (a.nodeId < b.nodeId ? -1 : 1),
  );
  const tier2 = (c: JournalCandidate) =>
    c.kind !== 'gap' &&
    (opts.alwaysOn ? !opts.alwaysOn.has(c.nodeId) : !TIER1_KINDS.includes(c.kind));
  const toPick = (c: JournalCandidate, max: number): JournalPick | null => {
    const full = c.body.replace(/\s+/g, ' ').trim();
    const long = full.length > TIER2_PASSAGE_CHARS;
    const passage = long && opts.passages?.has(c.nodeId) === true;
    const source = passage ? opts.passages!.get(c.nodeId)! : full;
    const text = flatten(source, Math.min(max, TIER2_PASSAGE_CHARS));
    const whole = !passage && text === full;
    // A cut-to-fit stub says nothing and would still dedupe the entry's facts.
    if (!text || (!whole && text.length < MIN_PICK_CHARS && !passage)) return null;
    return {
      nodeId: c.nodeId,
      kind: c.kind,
      lane: kindLane(c.kind),
      agentSlug: c.agentSlug,
      similarity: Math.round(c.similarity * 1000) / 1000,
      text,
      passage,
      whole,
    };
  };

  let gap: JournalPick | null = null;
  const openGap = sorted.find(
    (c) => c.kind === 'gap' && c.status !== 'resolved' && c.similarity >= opts.cutoff,
  );
  let budget = opts.budgetChars;
  if (openGap) {
    gap = toPick(openGap, budget);
    budget -= gap?.text.length ?? 0;
  }

  const picks: JournalPick[] = [];
  const nearMisses: JournalRelevance['nearMisses'] = [];
  const byScore = opts.agentScores;
  if (byScore) {
    const rules = sorted
      .filter(tier2)
      .map((c) => ({ c, score: byScore.scores.get(c.nodeId) }))
      .filter((x): x is { c: JournalCandidate; score: number } => x.score !== undefined)
      .filter((x) => x.score >= byScore.threshold)
      .sort((a, b) => b.score - a.score || (a.c.nodeId < b.c.nodeId ? -1 : 1));
    let ruleBudget = TIER2_RULES_CHARS;
    for (const { c, score } of rules) {
      if (picks.length >= TIER2_RULES_MAX_ENTRIES) break;
      const pick = toPick(c, Number.MAX_SAFE_INTEGER);
      if (!pick || pick.text.length > ruleBudget) continue;
      picks.push({ ...pick, score: Math.round(score * 100) / 100 });
      ruleBudget -= pick.text.length;
    }
  }
  let simPicks = 0;
  for (const c of sorted) {
    if (!tier2(c)) continue;
    if (byScore?.scores.has(c.nodeId)) continue;
    if (c.similarity < opts.cutoff) {
      if (nearMisses.length < TIER2_NEAR_MISSES) {
        nearMisses.push({
          nodeId: c.nodeId,
          kind: c.kind,
          similarity: Math.round(c.similarity * 1000) / 1000,
        });
      }
      continue;
    }
    if (simPicks >= TIER2_MAX_ENTRIES || budget <= 0) continue;
    const pick = toPick(c, simPicks === 0 ? budget : Number.MAX_SAFE_INTEGER);
    if (!pick) continue;
    if (simPicks > 0 && pick.text.length > budget) continue;
    picks.push(pick);
    simPicks++;
    budget -= pick.text.length;
  }
  const chars = picks.reduce((n, p) => n + p.text.length, 0) + (gap?.text.length ?? 0);
  return { picks, gap, nearMisses, chars };
}

/**
 * Pure renderer: the per-turn tier 2 + 3 block. Returns '' when nothing was
 * picked. An open gap raised by another agent keeps its attribution.
 */
export function renderRelevantJournalBlock(
  relevance: Pick<JournalRelevance, 'picks' | 'gap'>,
  currentAgentSlug?: string | null,
): string {
  const attribution = (p: JournalPick) =>
    p.agentSlug && p.agentSlug !== currentAgentSlug ? ` _(learned by ${p.agentSlug})_` : '';
  const user = relevance.picks.filter((p) => p.lane === 'user');
  const agent = relevance.picks.filter((p) => p.lane === 'agent');
  if (user.length + agent.length === 0 && !relevance.gap) return '';
  const lines: string[] = [
    'Journal entries that match the current message. User entries are',
    'first-person truth about the user; working notes are what you have',
    'learned about doing this job. Use what helps; do not recite it back unprompted.',
  ];
  if (user.length) {
    lines.push('', '## About the user', ...user.map((p) => `- (${p.kind}) ${p.text}`));
  }
  if (agent.length) {
    lines.push(
      '',
      '## Working notes',
      ...agent.map((p) => `- (${p.kind}) ${p.text}${attribution(p)}`),
    );
  }
  if (relevance.gap) {
    lines.push(
      '',
      '## Open question',
      'The brain is missing this knowledge and it fits this conversation. You may',
      'ask the user: never as an opener, and drop it if the user declines. When',
      'the user answers, record it with `journal_resolve_gap` so it is never asked',
      'again.',
      `- ${relevance.gap.text}${attribution(relevance.gap)}`,
    );
  }
  return `# From the Journal (relevant to this message)\n\n${lines.join('\n')}`;
}

/** A journal_recall rule: what Jev scores, and a tier 2 candidate even when
 *  the entry has no embedding yet (a fresh or just-edited rule). */
export type JournalRuleRow = {
  nodeId: string;
  kind: string;
  agentSlug: string | null;
  body: string;
};

/**
 * Tier 2 + 3 candidates for one turn: every journal entry the agent may see,
 * scored against the message embedding (one plain scan, not an index walk
 * that a type filter would starve), plus the best passage of each long match.
 * `rules` (journal_recall) join with similarity 0 when they have no
 * embedding, so Jev's score can still pick them. Lanes are gated separately
 * (`inject_journal` / `inject_working_notes`).
 */
export async function loadJournalCandidates(opts: {
  ownerId: string;
  queryVec: number[];
  agentSlug: string | null;
  userLane: boolean;
  agentLane: boolean;
  cutoff: number;
  /** Tier 1 shown ids; undefined = unknown (every tier 1 kind is left out). */
  alwaysOn?: ReadonlySet<string>;
  rules?: readonly JournalRuleRow[];
}): Promise<{ candidates: JournalCandidate[]; passages: Map<string, string> }> {
  const vec = JSON.stringify(opts.queryVec);
  const rows = await db
    .select({
      id: nodes.id,
      data: nodes.data,
      dist: sql<number>`${nodes.embedding} <=> ${vec}::vector`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, opts.ownerId),
        eq(nodes.type, 'journal'),
        isNotNull(nodes.embedding),
        journalVisibleSql(opts.agentSlug),
      ),
    )
    .limit(JOURNAL_SCAN_LIMIT);

  const laneOpen = (kind: string) => (kindLane(kind) === 'user' ? opts.userLane : opts.agentLane);
  const candidates: JournalCandidate[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const kind = effectiveKind(d);
    if (!laneOpen(kind)) continue;
    seen.add(r.id);
    candidates.push({
      nodeId: r.id,
      kind,
      agentSlug: agentSlugOf(d),
      status: typeof d.status === 'string' ? d.status : null,
      body: typeof d.body === 'string' ? d.body : '',
      similarity: 1 - Number(r.dist),
    });
  }
  for (const rule of opts.rules ?? []) {
    if (seen.has(rule.nodeId) || !laneOpen(rule.kind)) continue;
    candidates.push({ ...rule, status: null, similarity: 0 });
  }

  // Best passage of each long entry that could be picked.
  const longIds = candidates
    .filter(
      (c) =>
        c.kind !== 'gap' &&
        (opts.alwaysOn ? !opts.alwaysOn.has(c.nodeId) : !TIER1_KINDS.includes(c.kind)) &&
        c.body.replace(/\s+/g, ' ').trim().length > TIER2_PASSAGE_CHARS &&
        (c.similarity >= opts.cutoff || (opts.rules ?? []).some((r) => r.nodeId === c.nodeId)),
    )
    .map((c) => c.nodeId);
  const passages = new Map<string, string>();
  if (longIds.length > 0) {
    const chunks = await db
      .select({
        nodeId: contentChunks.nodeId,
        text: contentChunks.text,
        dist: sql<number>`${contentChunks.embedding} <=> ${vec}::vector`,
      })
      .from(contentChunks)
      .where(
        and(
          eq(contentChunks.ownerId, opts.ownerId),
          inArray(contentChunks.nodeId, longIds),
          isNotNull(contentChunks.embedding),
        ),
      );
    const best = new Map<string, number>();
    for (const c of chunks) {
      const d = Number(c.dist);
      if (d < (best.get(c.nodeId) ?? Number.POSITIVE_INFINITY)) {
        best.set(c.nodeId, d);
        passages.set(c.nodeId, c.text);
      }
    }
  }
  return { candidates, passages };
}

/**
 * Tiers 2 and 3 for one turn: load the candidates, then pick. Callers that
 * need two picks from one load (a shadow comparison) use
 * {@link loadJournalCandidates} + {@link pickJournalEntries} directly.
 */
export async function selectRelevantJournal(opts: {
  ownerId: string;
  queryVec: number[];
  inboundText: string;
  agentSlug: string | null;
  cutoff?: number;
  budgetChars?: number;
  userLane: boolean;
  agentLane: boolean;
  alwaysOn?: ReadonlySet<string>;
  rules?: readonly JournalRuleRow[];
  agentScores?: JournalAgentScores;
}): Promise<JournalRelevance> {
  const cutoff = opts.cutoff ?? JOURNAL_RELEVANCE_MIN_DEFAULT;
  const budgetChars = opts.budgetChars ?? JOURNAL_RELEVANT_CHARS_DEFAULT;
  const empty: JournalRelevance = {
    picks: [],
    gap: null,
    nearMisses: [],
    cutoff,
    chars: 0,
    skipped: null,
  };
  if (!opts.userLane && !opts.agentLane) return empty;
  if (isSmallTalk(opts.inboundText)) return { ...empty, skipped: 'small_talk' };
  const { candidates, passages } = await loadJournalCandidates({ ...opts, cutoff });
  return {
    ...pickJournalEntries(candidates, {
      cutoff,
      budgetChars,
      passages,
      ...(opts.alwaysOn ? { alwaysOn: opts.alwaysOn } : {}),
      ...(opts.agentScores ? { agentScores: opts.agentScores } : {}),
    }),
    cutoff,
    skipped: null,
  };
}

/** The rules `journal_recall` scores for one agent: its lessons and
 *  expectations, plus tier 1 overflow (`extraIds`: always-on entries that did
 *  not fit, rule-like by nature), newest first. Gaps are tier 3 and stay on
 *  similarity. Not gated on an embedding: Jev reads the text. */
export async function loadJournalRules(
  ownerId: string,
  agentSlug: string | null,
  extraIds: readonly string[] = [],
): Promise<JournalRuleRow[]> {
  const kindIn = sql`${journalKindSql()} in ('lesson', 'expectation')`;
  const rows = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'journal'),
        extraIds.length > 0 ? or(kindIn, inArray(nodes.id, [...extraIds])) : kindIn,
        journalVisibleSql(agentSlug),
      ),
    )
    .orderBy(desc(nodes.createdAt), desc(nodes.id))
    .limit(JOURNAL_RULES_LIMIT);
  return rows
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        nodeId: r.id,
        kind: effectiveKind(d),
        agentSlug: agentSlugOf(d),
        body: flatten(typeof d.body === 'string' ? d.body : '', TIER2_PASSAGE_CHARS),
      };
    })
    .filter((r) => r.body.length > 0);
}

/** memory_config.journal_tiers as it takes effect. `notes_target = 'journal'`
 *  implies `live`: the agent's notes then exist only in the Journal, and the
 *  old capped blocks would show ~6 of hundreds. */
export function journalTiersOf(
  memoryConfig: { journal_tiers?: string; notes_target?: string } | null | undefined,
): 'off' | 'shadow' | 'live' {
  // Learned notes live in the Journal unless the agent opts back into its
  // persona notes (notesTargetOf): then the old capped blocks would show
  // about 6 of hundreds, so the tiers are live.
  if (memoryConfig?.notes_target !== 'persona') return 'live';
  const t = memoryConfig?.journal_tiers;
  return t === 'off' || t === 'live' ? t : 'shadow';
}
