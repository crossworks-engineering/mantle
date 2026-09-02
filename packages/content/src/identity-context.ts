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
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { KINDS, kindLabel, legacyCategoryToKind } from '@mantle/content-core/journal-options';
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
    const category = typeof d.category === 'string' && d.category.trim() ? d.category.trim() : null;
    entries.push({
      body: typeof d.body === 'string' ? d.body : '',
      // Legacy rows (no kind) map their old category so they keep rendering.
      kind: rawKind ?? legacyCategoryToKind(category),
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
