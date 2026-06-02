/**
 * Seeds the `table_authoring` skill — the capability pack for working with
 * typed database grids (the Tables feature). Attached to the `tables` agent by
 * seed-tables-agent.ts; can also be attached to Saskia/an assistant directly so
 * she can build grids inline.
 *
 * Like rich_writing, the body is appended to the agent's system prompt by
 * composeSystemPromptWithSkills, and `toolSlugs` (the safe table_* subset) is
 * unioned into the agent's tool allowlist.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm tsx scripts/seed-tables-skill.ts
 *   ALLOWED_USER_ID=<uuid> ATTACH_AGENT=saskia pnpm tsx scripts/seed-tables-skill.ts
 *
 * Idempotent: upserts the skill by slug; optionally attaches to ATTACH_AGENT.
 */

import { and, eq } from 'drizzle-orm';
import { db, agents, skills } from '@mantle/db';
import { seedBuiltinTools, TABLE_TOOL_SLUGS } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
const ATTACH_AGENT = process.env.ATTACH_AGENT;

if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

export const SKILL_SLUG = 'table_authoring';

// The safe authoring subset: everything except the irreversible delete (that
// stays with the user / Saskia-with-confirm).
export const TABLE_AUTHORING_TOOL_SLUGS = TABLE_TOOL_SLUGS.filter((s) => s !== 'table_delete');

const SKILL_DESCRIPTION =
  'Build and operate typed database grids (Tables): typed columns, per-row edits by id, totals/aggregations, formulas, saved filter/sort views, and xlsx/csv import.';

const SKILL_INSTRUCTIONS = `You can build and operate **typed database grids** — the Tables feature. A
table is NOT a Pages rich-text table: it has typed columns, real totals,
formulas, sorting/filtering, and every row + column carries a stable id you
address directly. Reach for a table whenever the data is tabular: a stock list,
a price comparison, an online-services list, a budget, a tracker.

## The model

A table is \`{ columns, rows, aggregates, views }\`:
- **Columns** have a \`type\`: text · number · currency · percent · date ·
  datetime · checkbox · select · multiselect · url · formula. Pick the right
  type — it drives formatting, totals, and sorting.
- **Rows** are addressed by a stable \`id\`. "Update row 3", "delete that row",
  "set its status" all map onto a row id.
- **Aggregates** are per-column footer totals (sum / avg / count / min / max).
- **Views** are saved filter + sort configurations.

## How to work (ALWAYS read before you write)

1. \`table_rows_list({ table_id })\` — get the rows as id + short cell text. This
   is how you learn which row id to touch. Page with offset/limit on big grids.
   \`table_get\` adds the column list + current totals.
2. Then act by id:
   - \`table_row_update({ table_id, row_id, cells })\` — cells keyed by column
     NAME or id, e.g. \`{ "Qty": 3, "Status": "Open" }\`. The surgical "do row X".
   - \`table_row_add\` / \`table_row_delete\` / \`table_cell_set\`.
   - \`table_column_add\` / \`table_column_update\` / \`table_column_delete\`.

## Totals and formulas

- **"Add totals"** → \`table_set_aggregate({ table_id, column, kind })\` with
  kind sum|avg|count|min|max (or none to clear). It shows in the footer + the
  indexed text.
- **Computed columns** → add a \`formula\` column. The formula references other
  columns by name in braces and supports arithmetic + IF/ROUND/MIN/MAX/SUM/ABS:
  \`{Qty} * {Price}\`, \`ROUND({Total} * 0.15, 2)\`, \`IF({Paid}, 0, {Due})\`.
  Formulas are same-row only — column-wide math is an aggregate, not a formula.

## Importing spreadsheets

When the user hands you an .xlsx / .xls / .csv, use
\`table_from_file({ file_id })\` — bytes go server-side, types are inferred, and
one table is created per sheet (multi-sheet workbooks yield several tables).
Never \`file_read\` a spreadsheet and retype it.

## Draft / commit discipline (non-negotiable)

Every structural edit (rows, columns, cells, totals, views) writes to the
table's **draft**, NOT the published grid — exactly like the Pages draft model.
The published table and its brain index are untouched until a commit.

- After editing, report a short status and tell the user to open
  \`/tables/<id>\` to review; the editor shows the draft, Commit publishes (and
  re-indexes), Discard reverts.
- Only call \`table_commit\` yourself when the user explicitly says save / publish
  / make it live. Default: leave the draft for them to review.
- \`table_from_file\` and \`table_create\` publish immediately (there's nothing to
  review for a fresh import) — that's expected.
- Deletes (\`table_delete\`) are not in your toolset: if one's needed, ask the
  user to confirm and have Saskia do it.

Don't echo the whole grid back — the user is one click from seeing it. Give the
table id, what changed, and the review URL.`;

async function upsertSkill(): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.ownerId, USER_ID!), eq(skills.slug, SKILL_SLUG)))
    .limit(1);

  const values = {
    name: 'Table authoring',
    description: SKILL_DESCRIPTION,
    instructions: SKILL_INSTRUCTIONS,
    toolSlugs: TABLE_AUTHORING_TOOL_SLUGS,
    enabled: true,
  };

  if (existing) {
    await db.update(skills).set({ ...values, updatedAt: new Date() }).where(eq(skills.id, existing.id));
    console.log(`[seed] updated skill ${SKILL_SLUG}`);
  } else {
    await db.insert(skills).values({ ownerId: USER_ID!, slug: SKILL_SLUG, defaultState: {}, ...values });
    console.log(`[seed] inserted skill ${SKILL_SLUG}`);
  }
}

async function attachToAgent(agentSlug: string): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!row) {
    console.warn(`[seed] ATTACH_AGENT='${agentSlug}' not found — skipped`);
    return;
  }
  const current = row.skillSlugs ?? [];
  if (current.includes(SKILL_SLUG)) {
    console.log(`[seed] agent ${agentSlug} already has skill ${SKILL_SLUG}`);
    return;
  }
  await db.update(agents).set({ skillSlugs: [...current, SKILL_SLUG], updatedAt: new Date() }).where(eq(agents.id, row.id));
  console.log(`[seed] attached skill ${SKILL_SLUG} to agent ${agentSlug}`);
}

async function main() {
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[seed] builtin tools: ${seeded.inserted} inserted, ${seeded.updated} updated`);
  await upsertSkill();
  if (ATTACH_AGENT) await attachToAgent(ATTACH_AGENT);
  console.log(`[seed] done. Table tools in the skill: ${TABLE_AUTHORING_TOOL_SLUGS.join(', ')}`);
  console.log('[seed] toggle/edit at /settings/skills; read per turn (no restart needed).');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] error:', err);
  process.exit(1);
});
