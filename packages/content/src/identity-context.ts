/**
 * The always-on "who you are" identity block.
 *
 * Life Logs (./lifelog.ts) are the user's own statements about who they are,
 * what they do, and how they feel. This module distils them into a compact,
 * stable system block that callers prepend to the agent's system prompt on
 * every turn — so any agent "knows the user" without the user re-explaining.
 *
 * Cost-safety (project rule: never add triggers/loops that can run the LLM
 * away): the distillation here is **deterministic** — a bounded, category-
 * grouped selection of the user's real entries, NO LLM call. The output only
 * changes when the user adds/edits a life log, so it sits inside the cached
 * system block (same cadence as persona notes) and costs nothing per turn
 * beyond the tokens themselves. An LLM-summarised profile is a possible
 * Phase 2; this is the zero-risk v1.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { CATEGORIES, categoryLabel } from './lifelog-options';

/** Hard caps so the block can never balloon, however many entries exist. */
const MAX_PER_CATEGORY = 6;
const MAX_TOTAL = 30;
const MAX_ENTRY_CHARS = 280;

type Entry = { body: string; mood: string | null; category: string | null };

/**
 * Build the identity context block for an owner. Returns '' when the user has
 * no life logs (so the caller's concat is a clean no-op and the prompt is
 * unchanged). The block is plain text with `##` category headings; entries are
 * one bullet each, newest-first within a category.
 */
export async function buildIdentityContext(ownerId: string): Promise<string> {
  const rows = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'lifelog')))
    .orderBy(
      sql`coalesce((${nodes.data}->>'entry_date')::timestamptz, ${nodes.updatedAt}) desc`,
    )
    .limit(200);

  if (rows.length === 0) return '';

  const entries: Entry[] = rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const body = typeof d.body === 'string' ? d.body.replace(/\s+/g, ' ').trim() : '';
    return {
      body: body.length > MAX_ENTRY_CHARS ? `${body.slice(0, MAX_ENTRY_CHARS - 1).trimEnd()}…` : body,
      mood: typeof d.mood === 'string' && d.mood.trim() ? d.mood.trim() : null,
      category: typeof d.category === 'string' && d.category.trim() ? d.category.trim() : null,
    };
  });

  // Group by category (preserving the canonical CATEGORIES order; unknown /
  // null categories fall into a trailing "Other" bucket).
  const UNCAT = '__other__';
  const byCat = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!e.body) continue;
    const key = e.category && CATEGORIES.some((c) => c.key === e.category) ? e.category : UNCAT;
    const list = byCat.get(key) ?? [];
    if (list.length < MAX_PER_CATEGORY) list.push(e);
    byCat.set(key, list);
  }

  const orderedKeys = [...CATEGORIES.map((c) => c.key), UNCAT].filter((k) => byCat.has(k));

  const lines: string[] = [
    'The following is what the user has recorded about who they are, what they',
    'do, and how they feel (their "Life Log"). Treat it as durable, first-person',
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

  return `# About the user (Life Log)\n\n${lines.join('\n')}`;
}
