/**
 * The always-on "who you are" identity block.
 *
 * Journal entries (./journal.ts) are the user's own statements about who they are,
 * what they do, and how they feel. This module distils them into a compact,
 * stable system block that callers prepend to the agent's system prompt on
 * every turn — so any agent "knows the user" without the user re-explaining.
 *
 * Cost-safety (project rule: never add triggers/loops that can run the LLM
 * away): the distillation here is **deterministic** — a bounded, category-
 * grouped selection of the user's real entries, NO LLM call. The output only
 * changes when the user adds/edits a journal entry, so it sits inside the cached
 * system block (same cadence as persona notes) and costs nothing per turn
 * beyond the tokens themselves. An LLM-summarised profile is a possible
 * Phase 2; this is the zero-risk v1.
 */
import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { CATEGORIES, categoryLabel } from './journal-options';
import { journalSortSql } from './journal';
import { loadProfilePreferences } from './profile-preferences';
import { purposeArchetypeLabel } from './onboarding-questions';

/** Hard caps so the block can never balloon, however many entries exist. */
const MAX_PER_CATEGORY = 6;
const MAX_TOTAL = 30;
const MAX_ENTRY_CHARS = 280;
/** Cap the injected purpose so a runaway paste can't bloat every turn's prompt. */
const MAX_PURPOSE_CHARS = 600;

/** One journal entry, reduced to what the identity block needs. Entries should be
 *  passed newest-first (the DB query orders them); within a category that order
 *  is preserved. */
export type IdentityEntry = { body: string; mood: string | null; category: string | null };

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

/**
 * Pure renderer: turn journal entries into the `# About the user` block.
 * Deterministic and DB-free (unit-tested). Returns '' when nothing renders.
 *
 * Rules: bodies are whitespace-collapsed + truncated to MAX_ENTRY_CHARS;
 * grouped by category in the canonical CATEGORIES order (unknown/blank →
 * trailing "Other"); ≤ MAX_PER_CATEGORY entries per group and ≤ MAX_TOTAL
 * overall; empty-body entries are skipped; mood renders inline.
 */
export function renderIdentityBlock(entries: IdentityEntry[]): string {
  const cleaned = entries.map((e) => {
    const body = (e.body ?? '').replace(/\s+/g, ' ').trim();
    return {
      body:
        body.length > MAX_ENTRY_CHARS ? `${body.slice(0, MAX_ENTRY_CHARS - 1).trimEnd()}…` : body,
      mood: typeof e.mood === 'string' && e.mood.trim() ? e.mood.trim() : null,
      category: typeof e.category === 'string' && e.category.trim() ? e.category.trim() : null,
    };
  });

  // Group by category (canonical CATEGORIES order; unknown/null → trailing
  // "Other" bucket). Cap per category as we go.
  const UNCAT = '__other__';
  const byCat = new Map<string, IdentityEntry[]>();
  for (const e of cleaned) {
    if (!e.body) continue;
    const key = e.category && CATEGORIES.some((c) => c.key === e.category) ? e.category : UNCAT;
    const list = byCat.get(key) ?? [];
    if (list.length < MAX_PER_CATEGORY) list.push(e);
    byCat.set(key, list);
  }

  const orderedKeys = [...CATEGORIES.map((c) => c.key), UNCAT].filter((k) => byCat.has(k));

  const lines: string[] = [
    'The following is what the user has recorded about who they are, what they',
    'do, and how they feel (their "Journal"). Treat it as durable, first-person',
    'truth about the user. Use it to ground who you are talking to; do not recite',
    'it back unprompted.',
  ];
  let total = 0;
  for (const key of orderedKeys) {
    if (total >= MAX_TOTAL) break;
    const list = byCat.get(key)!;
    const heading = key === UNCAT ? 'Other' : (categoryLabel(key) ?? key);
    const bullets: string[] = [];
    for (const e of list) {
      if (total >= MAX_TOTAL) break;
      const moodTag = e.mood ? ` _(felt: ${e.mood})_` : '';
      bullets.push(`- ${e.body}${moodTag}`);
      total++;
    }
    if (bullets.length) {
      lines.push('', `## ${heading}`, ...bullets);
    }
  }

  // No category produced a bullet (e.g. all bodies empty) → no block.
  if (total === 0) return '';

  return `# About the user (Journal)\n\n${lines.join('\n')}`;
}

/**
 * Build the identity context block for an owner: the brain's purpose (from
 * profile preferences) followed by the "About the user" block distilled from the
 * Journal. Returns '' when neither is set (so the caller's concat is a clean
 * no-op). Thin DB wrapper over the pure `renderPurposeBlock` + `renderIdentityBlock`.
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

  const entries: IdentityEntry[] = rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      body: typeof d.body === 'string' ? d.body : '',
      mood: typeof d.mood === 'string' ? d.mood : null,
      category: typeof d.category === 'string' ? d.category : null,
    };
  });
  const journalBlock = renderIdentityBlock(entries);

  return [purposeBlock, journalBlock].filter(Boolean).join('\n\n');
}
