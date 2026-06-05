/**
 * Seed "Pages" — Jason's page-authoring & editing specialist (Phase 2a).
 *
 * Where Saskia is a generalist conversationalist, Pages is a focused
 * design-conscious editor: importing markdown files into pages, restyling
 * existing pages with the rich Mantle dialect (callouts / columns / tables /
 * task lists / KaTeX), and producing clean, on-brand documents.
 *
 * Division of labour:
 *   - Saskia  → delegates to Pages whenever the user's intent is page-shaped
 *               ("import this file as a page", "style the Potter sermon",
 *               "make a doc summarising X"). Saskia stays in the
 *               conversation; Pages does the document work.
 *   - Pages   → returns a short status (what changed, page id, suggested
 *               next step) — not a full document echo. Saskia relays it.
 *
 * Phase 2a scope: whole-doc transforms on small / medium pages (under ~12 KB
 * body comfortably fits the 16K max_tokens cap). Phase 2b will add block-
 * addressed editing (page_blocks_list / page_block_update / …) so output
 * scales with CHANGES not document size — see docs/pages.md §8.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:pages
 *
 * Idempotent: upserts the agent by (owner, slug='pages'), appends 'pages'
 * to each entry-point agent's delegate_to — only when missing.
 */

import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { db, agents, apiKeys, skills, type AgentMemoryConfig } from '@mantle/db';
import { seedBuiltinTools, PAGE_TOOL_SLUGS } from '@mantle/tools';

const MODEL = process.env.PAGES_MODEL || 'anthropic/claude-sonnet-4.6';

// Strip BOTH the destructive ops AND the live-overwrite path:
//   - page_delete  → requires_confirm anyway; not the agent's job
//   - page_update  → writes straight to the published `doc`; the Pages agent
//                    MUST go through page_update_draft so a misbehaving
//                    transform can never silently overwrite a live page
const PAGE_AUTHORING_TOOL_SLUGS = PAGE_TOOL_SLUGS.filter(
  (s) => s !== 'page_delete' && s !== 'page_update',
);

const TOOL_SLUGS = [
  // Page CRUD (sans delete)
  ...PAGE_AUTHORING_TOOL_SLUGS,
  // Source files (to import / reference)
  'file_read',
  'file_list',
  'file_get',
  'folder_list',
  // Cross-page context — "is there already a page about X before I make one?"
  'search_nodes',
  'node_read',
];

const SYSTEM_PROMPT = `You are "Pages" — Jason's document authoring and editing specialist. Saskia (the main assistant) delegates page-shaped work to you: importing markdown files as pages, restyling existing pages with the rich Mantle dialect, drafting clean documents from notes.

You operate inside Mantle's own page surface. Two attached skills give you everything you need, and you must follow both:
- **rich_writing** — the dialect: callouts, columns, tables, task lists, highlights, KaTeX math.
- **page_editing** — how to edit pages safely and at scale: preserve every word and block kind verbatim, prefer block-level tools, import via page_from_file. This is non-negotiable — it's how you avoid silently rewriting or truncating the operator's content.

Pages render the same way for the operator regardless of which agent authored them, so what you write IS what they see.

Your role:
- You're a one-shot specialist invoked per task. Do the work, then report a short status — what you did, how many blocks changed, the page id, and where to review the draft (the tool's hint field has the URL). Don't echo the page body back; the user is one click from seeing it. Then return.
- Ask one short clarifying question when scope is genuinely ambiguous ("add callouts" could mean every quote or just the headline points) rather than over-editing.
- Don't decide what to remember — the brain re-indexes every page on commit automatically (summary, embedding, entities, facts).
- Deletes aren't yours: if one's needed, tell Saskia to confirm it with the user.`;

async function resolveOpenRouterKeyId(ownerId: string): Promise<string> {
  const rows = await db
    .select({ id: apiKeys.id, label: apiKeys.label })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, ownerId), eq(apiKeys.service, 'openrouter')));
  if (rows.length === 0) {
    throw new Error("No 'openrouter' API key found. Add one at /settings/keys first.");
  }
  const preferred = rows.find((r) => r.label === 'default') ?? rows[0]!;
  return preferred.id;
}

/** The Pages agent runs on two skills: rich_writing (the dialect) and
 *  page_editing (safe block-level editing). Both are seeded elsewhere
 *  (seed:rich-writing and seed:shared-skills). Look up whichever are present so
 *  we attach them by slug; missing = warn but don't fail. */
async function present_skill_slugs(ownerId: string): Promise<string[]> {
  const wanted = ['rich_writing', 'page_editing'];
  const rows = await db
    .select({ slug: skills.slug })
    .from(skills)
    .where(and(eq(skills.ownerId, ownerId), inArray(skills.slug, wanted)));
  // Preserve the intended order (rich_writing first).
  return wanted.filter((w) => rows.some((r) => r.slug === w));
}

/**
 * Append 'pages' to EVERY enabled responder + assistant agent's delegate_to
 * (only when missing). Diverges from the researcher/remy pattern, which
 * wired only the highest-priority one — that broke for Jason's setup where
 * two responders share priority=100 and the tiebreaker is undefined. For
 * a delegation grant, "all eligible entry points" is the right scope.
 */
async function grantToEntryAgents(ownerId: string): Promise<void> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      role: agents.role,
      memoryConfig: agents.memoryConfig,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.enabled, true)));

  const eligible = rows.filter((r) => r.role === 'responder' || r.role === 'assistant');
  if (eligible.length === 0) {
    console.log('[pages] no enabled responder or assistant found — skip wiring');
    return;
  }

  for (const agent of eligible) {
    const mc = (agent.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
    const delegateTo = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
    if (delegateTo.includes('pages')) {
      console.log(`[pages] ${agent.slug} (${agent.role}) already wired`);
      continue;
    }
    await db
      .update(agents)
      .set({
        memoryConfig: { ...mc, delegate_to: [...delegateTo, 'pages'] },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id));
    console.log(`[pages] ${agent.slug} (${agent.role}): +delegate_to 'pages'`);
  }
}

export async function seedPagesAgent(ownerId: string): Promise<void> {
  const seeded = await seedBuiltinTools(ownerId);
  console.log(`[pages] tools seeded: +${seeded.inserted} / ~${seeded.updated}`);

  const apiKeyId = await resolveOpenRouterKeyId(ownerId);
  const skillSlugs = await present_skill_slugs(ownerId);
  if (!skillSlugs.includes('rich_writing')) {
    console.warn(
      "[pages] WARNING: rich_writing skill not found. Run `pnpm seed:rich-writing` first.",
    );
  }
  if (!skillSlugs.includes('page_editing')) {
    console.warn(
      "[pages] WARNING: page_editing skill not found. Run `pnpm seed:shared-skills` first, " +
        "then re-run this script — without it the Pages prompt no longer carries the editing discipline.",
    );
  }

  const values = {
    ownerId,
    slug: 'pages',
    name: 'Pages',
    description:
      'Document authoring + editing specialist. Imports markdown files into pages, restyles existing pages with the rich Mantle dialect, drafts clean documents from notes.',
    role: 'custom' as const,
    model: MODEL,
    apiKeyId,
    systemPrompt: SYSTEM_PROMPT,
    toolSlugs: TOOL_SLUGS,
    skillSlugs,
    // Sonnet 4.6 via OpenRouter advertises a 128K output cap (1M context).
    // 32K is the sweet spot for Phase 2a whole-doc transforms — comfortably
    // fits ~25 KB body without truncation while keeping the paraphrase-loss
    // surface bounded (bigger cap = bigger window for the model to silently
    // condense, even with the HARD RULE). Phase 2b (block-addressed edits)
    // is what handles larger pages without the output cap mattering at all.
    params: { temperature: 0.3, max_tokens: 32000 },
    // max_iterations: Pages does batch work (page_blocks_list → page_block_get
    // ×N → page_block_update ×N), which needs many more loop iterations than
    // the default 6 used for conversational turns. 20 lets a 8-block edit
    // complete with overhead headroom; the runtime clamps at 30. Without
    // this Pages hits force_final mid-task and returns an empty reply.
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
  console.log(
    `[pages] agent upserted (model=${MODEL}, ${TOOL_SLUGS.length} tools, ` +
      `${values.skillSlugs.length} skill${values.skillSlugs.length === 1 ? '' : 's'})`,
  );

  await grantToEntryAgents(ownerId);

  console.log(
    "[pages] done. Restart apps/agent so the new agent + skill grants register. " +
      "Test from /assistant: \"Pages, import /files/notion-import/foo.md as a page\".",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedPagesAgent(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
