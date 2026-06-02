/**
 * Seed "Tables" — Jason's typed-grid specialist. The Pages-equivalent for
 * tabular data: building database grids, importing spreadsheets, adding totals
 * and formulas, and doing per-row edits the operator describes ("set row 3 to
 * paid", "total the price column", "sort by date").
 *
 * Division of labour:
 *   - Saskia  → delegates to Tables whenever the user's intent is grid-shaped
 *               ("make a table of …", "import this xlsx", "add a totals row",
 *               "update the stock count for the bolts"). Saskia stays in the
 *               conversation; Tables does the grid work and reports a status.
 *   - Tables  → reads rows by id, edits into the DRAFT, returns a short status
 *               (what changed, the table id, the review URL). Never echoes the
 *               whole grid.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:tables
 *
 * Idempotent: upserts the agent by (owner, slug='tables'), appends 'tables' to
 * each entry-point agent's delegate_to (only when missing). Run seed:tables-skill
 * first so the table_authoring skill exists to attach.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, agents, apiKeys, skills, type AgentMemoryConfig } from '@mantle/db';
import { seedBuiltinTools, TABLE_TOOL_SLUGS } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const MODEL = process.env.TABLES_MODEL || 'anthropic/claude-sonnet-4.6';

// The safe authoring subset: everything except the irreversible delete. Derived
// here (NOT imported from seed-tables-skill, which self-executes on import).
const TABLE_AUTHORING_TOOL_SLUGS = TABLE_TOOL_SLUGS.filter((s) => s !== 'table_delete');

const TOOL_SLUGS = [
  // Table authoring (CRUD + row/column/cell edits + totals + views; no delete)
  ...TABLE_AUTHORING_TOOL_SLUGS,
  // Source files (to import spreadsheets / reference)
  'file_read',
  'file_list',
  'file_get',
  'folder_list',
  // Cross-table context — "is there already a table about X before I make one?"
  'search_nodes',
  'node_read',
];

const SYSTEM_PROMPT = `You are "Tables" — Jason's typed-grid specialist. Saskia (the main assistant) delegates grid-shaped work to you: building database tables, importing spreadsheets, adding totals/formulas, and doing the per-row edits the operator describes.

The attached **table_authoring** skill is your manual — follow it exactly. The essentials:
- A table has typed columns and stable row/column ids. ALWAYS \`table_rows_list\` (or \`table_get\`) to learn the current ids before you edit, then act by id.
- Every structural edit writes to the DRAFT. The published table + its brain index are untouched until commit. Report a short status + the /tables/<id> review URL; only \`table_commit\` when the user explicitly says save/publish.
- Import spreadsheets with \`table_from_file\` (never retype a sheet). "Add totals" → \`table_set_aggregate\`. Computed columns → a \`formula\` column (\`{Qty} * {Price}\`).

Your role:
- You're a one-shot specialist invoked per task. Do the work, then report what changed (table id, rows/columns touched, the review URL from the tool's hint). Don't echo the grid; the user is one click from seeing it. Then return.
- Ask one short clarifying question when scope is genuinely ambiguous ("which column should the total go on?") rather than guessing destructively.
- Don't decide what to remember — the brain re-indexes the table on commit automatically.
- Deletes aren't yours: if a table or row delete is risky, tell Saskia to confirm it with the user.`;

async function resolveOpenRouterKeyId(): Promise<string> {
  const rows = await db
    .select({ id: apiKeys.id, label: apiKeys.label })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, USER_ID!), eq(apiKeys.service, 'openrouter')));
  if (rows.length === 0) {
    throw new Error("No 'openrouter' API key found. Add one at /settings/keys first.");
  }
  const preferred = rows.find((r) => r.label === 'default') ?? rows[0]!;
  return preferred.id;
}

async function present_skill_slugs(): Promise<string[]> {
  const wanted = ['table_authoring'];
  const rows = await db
    .select({ slug: skills.slug })
    .from(skills)
    .where(and(eq(skills.ownerId, USER_ID!), inArray(skills.slug, wanted)));
  return wanted.filter((w) => rows.some((r) => r.slug === w));
}

/** Append 'tables' to every enabled responder + assistant agent's delegate_to
 *  (only when missing). Same scope as the Pages wiring. */
async function grantToEntryAgents(): Promise<void> {
  const rows = await db
    .select({ id: agents.id, slug: agents.slug, role: agents.role, memoryConfig: agents.memoryConfig })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.enabled, true)));

  const eligible = rows.filter((r) => r.role === 'responder' || r.role === 'assistant');
  if (eligible.length === 0) {
    console.log('[tables] no enabled responder or assistant found — skip wiring');
    return;
  }
  for (const agent of eligible) {
    const mc = (agent.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
    const delegateTo = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
    if (delegateTo.includes('tables')) {
      console.log(`[tables] ${agent.slug} (${agent.role}) already wired`);
      continue;
    }
    await db
      .update(agents)
      .set({ memoryConfig: { ...mc, delegate_to: [...delegateTo, 'tables'] }, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
    console.log(`[tables] ${agent.slug} (${agent.role}): +delegate_to 'tables'`);
  }
}

async function main() {
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[tables] tools seeded: +${seeded.inserted} / ~${seeded.updated}`);

  const apiKeyId = await resolveOpenRouterKeyId();
  const skillSlugs = await present_skill_slugs();
  if (!skillSlugs.includes('table_authoring')) {
    console.warn(
      "[tables] WARNING: table_authoring skill not found. Run `pnpm -C apps/web seed:tables-skill` first, " +
        'then re-run this script — without it the Tables prompt loses the grid manual.',
    );
  }

  const values = {
    ownerId: USER_ID!,
    slug: 'tables',
    name: 'Tables',
    description:
      'Typed-grid specialist. Builds database tables, imports spreadsheets, adds totals/formulas, and does per-row edits by id. Writes to draft; the operator reviews + commits.',
    role: 'custom' as const,
    model: MODEL,
    apiKeyId,
    systemPrompt: SYSTEM_PROMPT,
    toolSlugs: TOOL_SLUGS,
    skillSlugs,
    params: { temperature: 0.3, max_tokens: 16000 },
    // Batch row/column edits need many tool-loop iterations (rows_list → N
    // edits); 20 gives headroom (runtime clamps at 30).
    memoryConfig: { max_iterations: 20 } as AgentMemoryConfig,
    priority: 100,
    enabled: true,
  };

  await db
    .insert(agents)
    .values(values)
    .onConflictDoUpdate({
      target: [agents.ownerId, agents.slug],
      set: {
        name: values.name,
        description: values.description,
        role: values.role,
        model: values.model,
        apiKeyId: values.apiKeyId,
        systemPrompt: values.systemPrompt,
        toolSlugs: values.toolSlugs,
        skillSlugs: values.skillSlugs,
        params: values.params,
        memoryConfig: values.memoryConfig,
        enabled: true,
        updatedAt: new Date(),
      },
    });
  console.log(`[tables] agent upserted (model=${MODEL}, ${TOOL_SLUGS.length} tools, ${values.skillSlugs.length} skill(s))`);

  await grantToEntryAgents();

  console.log(
    '[tables] done. Restart apps/agent so the new agent + skill grants register. ' +
      'Test from /assistant: "Tables, import /files/<sheet>.xlsx as a table".',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[tables] failed:', err);
  process.exit(1);
});
