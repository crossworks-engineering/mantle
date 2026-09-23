/**
 * The always-on journal-derived context blocks.
 *
 * Journal entries (./journal.ts) live in two lanes. User-lane entries are the
 * user's own statements about who they are and what they want; this module
 * distils them into a compact "# About the user" block. Agent-lane entries are
 * what agents have learned about doing their job (lessons, expectations) plus
 * the questions they still need answered (open gaps); those distil into a
 * per-turn "# Working notes" block. Callers prepend both to the agent's system
 * prompt on every turn — so any agent knows the user AND its own accumulated
 * craft without either being re-explained.
 *
 * Cost-safety (project rule: never add triggers/loops that can run the LLM
 * away): the distillation here is **deterministic** — a bounded, kind-grouped
 * selection of real entries, NO LLM call. The output only changes when an
 * entry is added/edited, so it sits inside the cached system block (same
 * cadence as persona notes) and costs nothing per turn beyond the tokens.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { contentChunks, db, nodes } from '@mantle/db';
import {
  KINDS,
  kindLabel,
  kindLane,
  legacyCategoryToKind,
} from '@mantle/content-core/journal-options';
import { journalSortSql } from './journal';
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

/** One journal entry, reduced to what the blocks need. Entries should be
 *  passed newest-first (the DB query orders them); within a group that order
 *  is preserved. */
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
 * Agent notes are SHARED across agents (v1 decision): every agent sees all
 * lessons and expectations, attributed to the agent that learned them when it
 * wasn't this one. Open gaps render as an "Open questions" tail so the agent
 * knows what the brain is missing and can ask when it fits the conversation.
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
export async function buildIdentityContext(ownerId: string): Promise<string> {
  const [prefs, rows] = await Promise.all([
    loadProfilePreferences(ownerId),
    db
      .select({ data: nodes.data })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')))
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
 * Build the per-agent "# Working notes" block: shared agent-lane entries
 * (lessons, expectations) plus open gap questions, newest first. Returns ''
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
// `memory_config.journal_tiers = 'live'`):
//   Tier 1, always on: purpose + identity / goal / preference, full text,
//     oldest first, in the cached notes block AFTER the persona prompt.
//   Tier 2, per turn: context entries and agent lessons / expectations whose
//     embedding matches the message, the matching passage only, ~3k chars.
//   Tier 3, per turn: at most one open gap question, only when it matches.
// Tiers 2 and 3 ride an uncached block, so a Journal write busts nothing.

/** Kinds that are always on (tier 1). */
export const TIER1_KINDS: readonly string[] = ['identity', 'goal', 'preference'];
/** Tier 1 keeps full text, but a runaway paste still cannot bloat every turn. */
const TIER1_MAX_ENTRY_CHARS = 1_500;
const TIER1_MAX_CHARS = 8_000;
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
/** How many journal rows one relevance pass reads (all of a normal brain). */
const TIER2_SCAN_LIMIT = 500;
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

function flatten(body: string, max: number): string {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Pure renderer: the tier 1 block. `entries` come oldest first; they are
 * grouped by kind (identity, goal, preference) and keep that order inside a
 * group, so a new entry appends and an old one never moves. Full text up to
 * TIER1_MAX_ENTRY_CHARS; the block stops at TIER1_MAX_CHARS. Returns '' when
 * neither the purpose nor any entry renders.
 */
export function renderJournalTier1Block(purposeBlock: string, entries: IdentityEntry[]): string {
  const byKind = new Map<string, string[]>();
  for (const e of entries) {
    const kind = e.kind ?? '';
    if (!TIER1_KINDS.includes(kind)) continue;
    const body = flatten(e.body, TIER1_MAX_ENTRY_CHARS);
    if (!body) continue;
    byKind.set(kind, [...(byKind.get(kind) ?? []), body]);
  }
  const lines: string[] = [
    'What the user has recorded about who they are, what they want and how',
    'they like to work (their "Journal"). Treat it as durable, first-person',
    'truth about the user. Do not recite it back unprompted.',
  ];
  let chars = 0;
  let count = 0;
  for (const kind of TIER1_KINDS) {
    const list = byKind.get(kind);
    if (!list) continue;
    const bullets: string[] = [];
    for (const body of list) {
      if (chars + body.length > TIER1_MAX_CHARS) break;
      bullets.push(`- ${body}`);
      chars += body.length;
      count++;
    }
    if (bullets.length) lines.push('', `## ${kindLabel(kind) ?? kind}`, ...bullets);
  }
  const journal = count > 0 ? `# About the user (Journal)\n\n${lines.join('\n')}` : '';
  return [purposeBlock, journal].filter(Boolean).join('\n\n');
}

/**
 * Tier 1 for an owner: the brain's purpose plus the always-on user-lane
 * entries, oldest first (created_at, then id, so the order never shifts on
 * an edit). Deterministic, no LLM; it only changes when such an entry or the
 * purpose changes.
 */
export async function buildJournalTier1(ownerId: string): Promise<string> {
  const [prefs, rows] = await Promise.all([
    loadProfilePreferences(ownerId),
    db
      .select({ data: nodes.data })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'journal')))
      .orderBy(asc(nodes.createdAt), asc(nodes.id))
      .limit(TIER2_SCAN_LIMIT),
  ]);
  const purposeBlock = renderPurposeBlock(
    prefs.purpose ?? '',
    purposeArchetypeLabel(prefs.purposeArchetype),
  );
  const entries: IdentityEntry[] = rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return { body: typeof d.body === 'string' ? d.body : '', kind: effectiveKind(d) };
  });
  return renderJournalTier1Block(purposeBlock, entries);
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

/** Greetings, thanks and one-word acknowledgements: no Journal lookup
 *  (spike 10: short test prompts pulled entries at 0.66 to 0.75). */
export function isSmallTalk(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!.?,\s]+$/g, '');
  if (!t) return true;
  if (t.split(/\s+/).length <= 1 && !/\?/.test(text)) return true;
  return /^(hi|hey|hello|hiya|yo|thanks|thank you|thx|cheers|ok|okay|k|cool|great|nice|perfect|sure|yes|no|yep|nope|got it|sounds good|good (morning|afternoon|evening|night)|morning|evening|night|bye|see you)( (there|again|so much|a lot|mate|all))?$/.test(
    t,
  );
}

export type JournalCandidate = {
  nodeId: string;
  kind: string;
  agentSlug: string | null;
  status: string | null;
  body: string;
  similarity: number;
};

/**
 * Pure: choose tier 2 entries and the tier 3 gap from scored candidates.
 * Tier 2 kinds are everything that is not tier 1 or a gap (context, free-text
 * user kinds, lessons, expectations). Best similarity first, at or above the
 * cutoff, at most TIER2_MAX_ENTRIES, inside the character budget (the first
 * pick is cut to fit rather than dropped). `passages` maps a node id to its
 * best-matching passage, used when the body is long.
 */
export function pickJournalEntries(
  candidates: readonly JournalCandidate[],
  opts: {
    cutoff: number;
    budgetChars: number;
    passages?: ReadonlyMap<string, string>;
    /** journal_recall scores by node id. When set, agent-lane rules are
     *  picked by score (at or above `threshold`, best first, their own
     *  budget) instead of by similarity; the user lane is unchanged. */
    agentScores?: { scores: ReadonlyMap<string, number>; threshold: number };
  },
): Pick<JournalRelevance, 'picks' | 'gap' | 'nearMisses' | 'chars'> {
  const sorted = [...candidates].sort((a, b) => b.similarity - a.similarity);
  const toPick = (c: JournalCandidate, max: number): JournalPick => {
    const long = c.body.replace(/\s+/g, ' ').trim().length > TIER2_PASSAGE_CHARS;
    const source = long ? (opts.passages?.get(c.nodeId) ?? c.body) : c.body;
    return {
      nodeId: c.nodeId,
      kind: c.kind,
      lane: kindLane(c.kind),
      agentSlug: c.agentSlug,
      similarity: Math.round(c.similarity * 1000) / 1000,
      text: flatten(source, Math.min(max, TIER2_PASSAGE_CHARS)),
      passage: long && opts.passages?.has(c.nodeId) === true,
    };
  };

  let gap: JournalPick | null = null;
  const openGap = sorted.find(
    (c) => c.kind === 'gap' && c.status !== 'resolved' && c.similarity >= opts.cutoff,
  );
  let budget = opts.budgetChars;
  if (openGap) {
    gap = toPick(openGap, budget);
    budget -= gap.text.length;
  }

  const picks: JournalPick[] = [];
  const nearMisses: JournalRelevance['nearMisses'] = [];
  const byScore = opts.agentScores;
  if (byScore) {
    const rules = sorted
      .filter((c) => c.kind !== 'gap' && !TIER1_KINDS.includes(c.kind))
      .filter((c) => kindLane(c.kind) === 'agent')
      .map((c) => ({ c, score: byScore.scores.get(c.nodeId) }))
      .filter((x): x is { c: JournalCandidate; score: number } => x.score !== undefined)
      .filter((x) => x.score >= byScore.threshold)
      .sort((a, b) => b.score - a.score);
    let ruleBudget = TIER2_RULES_CHARS;
    for (const { c, score } of rules) {
      if (picks.length >= TIER2_RULES_MAX_ENTRIES) break;
      const pick = toPick(c, Number.MAX_SAFE_INTEGER);
      if (!pick.text || pick.text.length > ruleBudget) continue;
      picks.push({ ...pick, score: Math.round(score * 100) / 100 });
      ruleBudget -= pick.text.length;
    }
  }
  for (const c of sorted) {
    if (c.kind === 'gap' || TIER1_KINDS.includes(c.kind)) continue;
    if (byScore && kindLane(c.kind) === 'agent') continue;
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
    const simPicks = picks.filter((p) => p.score === undefined).length;
    if (simPicks >= TIER2_MAX_ENTRIES || budget <= 0) continue;
    const pick = toPick(c, simPicks === 0 ? budget : Number.MAX_SAFE_INTEGER);
    if (!pick.text) continue;
    if (simPicks > 0 && pick.text.length > budget) continue;
    picks.push(pick);
    budget -= pick.text.length;
  }
  const chars = picks.reduce((n, p) => n + p.text.length, 0) + (gap?.text.length ?? 0);
  return { picks, gap, nearMisses, chars };
}

/**
 * Pure renderer: the per-turn tier 2 + 3 block. Returns '' when nothing was
 * picked. Lessons and expectations learned by another agent carry the same
 * attribution as the old working-notes block.
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
    'first-person truth about the user; working notes are what the agents of',
    'this brain have learned. Use what helps; do not recite it back unprompted.',
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

/**
 * Tiers 2 and 3 for one turn: score every journal entry of the owner against
 * the message embedding (a brain holds hundreds at most, so this is one
 * plain scan, not an index walk that a type filter would starve), fetch the
 * best passage of each long match, and pick within the budget. Lanes are
 * gated separately (`inject_journal` / `inject_working_notes`).
 */
export async function selectRelevantJournal(opts: {
  ownerId: string;
  queryVec: number[];
  inboundText: string;
  cutoff?: number;
  budgetChars?: number;
  userLane: boolean;
  agentLane: boolean;
  /** journal_recall scores (live): agent-lane rules picked by Jev. */
  agentScores?: { scores: ReadonlyMap<string, number>; threshold: number };
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

  const vec = JSON.stringify(opts.queryVec);
  const rows = await db
    .select({
      id: nodes.id,
      data: nodes.data,
      dist: sql<number>`${nodes.embedding} <=> ${vec}::vector`,
    })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, opts.ownerId), eq(nodes.type, 'journal'), isNotNull(nodes.embedding)),
    )
    .limit(TIER2_SCAN_LIMIT);

  const candidates: JournalCandidate[] = [];
  for (const r of rows) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const kind = effectiveKind(d);
    const lane = kindLane(kind);
    if (lane === 'user' ? !opts.userLane : !opts.agentLane) continue;
    candidates.push({
      nodeId: r.id,
      kind,
      agentSlug: typeof d.agent_slug === 'string' ? d.agent_slug : null,
      status: typeof d.status === 'string' ? d.status : null,
      body: typeof d.body === 'string' ? d.body : '',
      similarity: 1 - Number(r.dist),
    });
  }

  // Best passage of each long match that could be picked.
  const longIds = candidates
    .filter(
      (c) =>
        c.similarity >= cutoff &&
        !TIER1_KINDS.includes(c.kind) &&
        c.body.replace(/\s+/g, ' ').trim().length > TIER2_PASSAGE_CHARS,
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

  return {
    ...pickJournalEntries(candidates, {
      cutoff,
      budgetChars,
      passages,
      ...(opts.agentScores ? { agentScores: opts.agentScores } : {}),
    }),
    cutoff,
    skipped: null,
  };
}

/** The Journal's agent-lane rules (lessons, expectations) for
 *  `journal_recall`: id + body. Gaps are tier 3 and stay on similarity. */
export async function loadJournalRules(
  ownerId: string,
): Promise<Array<{ nodeId: string; kind: string; body: string }>> {
  const rows = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'journal'),
        sql`${nodes.data}->>'kind' in ('lesson', 'expectation')`,
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .limit(TIER2_SCAN_LIMIT);
  return rows
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        nodeId: r.id,
        kind: typeof d.kind === 'string' ? d.kind : 'lesson',
        body: flatten(typeof d.body === 'string' ? d.body : '', TIER2_PASSAGE_CHARS),
      };
    })
    .filter((r) => r.body.length > 0);
}
