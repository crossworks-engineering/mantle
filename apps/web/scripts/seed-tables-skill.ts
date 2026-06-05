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

import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db, agents, skills } from '@mantle/db';
import { seedBuiltinTools, TABLE_TOOL_SLUGS } from '@mantle/tools';

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

## Building a table from data

- **Data already in the conversation** (a block of results, a CSV/TSV blob, a
  markdown table the user pasted) → \`table_from_text({ data })\` in ONE call. It
  parses the whole block server-side (header row → columns, types inferred).
  **Never create an empty table and add rows one at a time with table_row_add
  for bulk data** — that's slow and you'll hit your iteration cap; \`table_from_text\`
  ingests it all at once. Use table_row_add only for a row or two by hand.
- **A spreadsheet file** (.xlsx / .xls / .csv) → \`table_from_file({ file_id })\`:
  bytes go server-side, types inferred, one table per sheet. Never \`file_read\` a
  spreadsheet and retype it.

## Powerful moves (what you can do well)

You're more than a row editor — reach for these when they fit:
- **Derived columns** — add a \`formula\` column for any per-row computation:
  line totals (\`{Qty} * {Price}\`), margins (\`ROUND(({Price}-{Cost})/{Price}*100, 1)\`),
  flags (\`IF({Days} > 30, 'overdue', 'ok')\`), concatenations (\`CONCAT({First}, ' ', {Last})\`).
- **Totals** — per-column footer aggregates (sum/avg/count/min/max) via
  table_set_aggregate; great for budgets and tallies.
- **Views** — saved sort + filter via table_set_view ("sort by date desc",
  "only rows where Status = Open").
- **Re-typing & formatting** — change a column's type (text→number/date/currency)
  with table_column_update; set currency code / decimals via its \`format\`.
- **Categorising** — turn a freehand column into a \`select\` with options, then
  set each row's value.
- **Cleanup** — normalise values cell-by-cell (trim, fix casing, fill blanks),
  or restructure by adding/renaming/deleting columns.
- **Splitting / combining** — read the rows, then write a new column whose cells
  are derived from existing ones (e.g. split "Full name" into First / Last).
- **Bulk build** — table_from_text to turn a pasted block of results into a grid.

Plan multi-step work: table_rows_list (or table_get) to see the current ids and
values, decide the columns/edits, then apply them. You have plenty of tool-loop
iterations — use them.

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

async function upsertSkill(ownerId: string): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.ownerId, ownerId), eq(skills.slug, SKILL_SLUG)))
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
    await db.insert(skills).values({ ownerId, slug: SKILL_SLUG, defaultState: {}, ...values });
    console.log(`[seed] inserted skill ${SKILL_SLUG}`);
  }
}

async function attachToAgent(ownerId: string, agentSlug: string): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, agentSlug)))
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

export async function seedTablesSkill(ownerId: string): Promise<void> {
  const seeded = await seedBuiltinTools(ownerId);
  console.log(`[seed] builtin tools: ${seeded.inserted} inserted, ${seeded.updated} updated`);
  await upsertSkill(ownerId);
  const ATTACH_AGENT = process.env.ATTACH_AGENT;
  if (ATTACH_AGENT) await attachToAgent(ownerId, ATTACH_AGENT);
  console.log(`[seed] done. Table tools in the skill: ${TABLE_AUTHORING_TOOL_SLUGS.join(', ')}`);
  console.log('[seed] toggle/edit at /settings/skills; read per turn (no restart needed).');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedTablesSkill(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
