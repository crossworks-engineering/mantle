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

import { and, eq } from 'drizzle-orm';
import { db, agents, apiKeys, skills, type AgentMemoryConfig } from '@mantle/db';
import { seedBuiltinTools, PAGE_TOOL_SLUGS } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const MODEL = process.env.PAGES_MODEL || 'anthropic/claude-sonnet-4.6';

// PAGE_TOOL_SLUGS includes page_delete (which is requiresConfirm:true). The
// Pages agent never proactively deletes — that's a user-initiated destructive
// action — so we strip it from the grant. Keeping the agent focused on
// authoring + editing makes its scope unambiguous.
const PAGE_AUTHORING_TOOL_SLUGS = PAGE_TOOL_SLUGS.filter((s) => s !== 'page_delete');

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

You operate inside Mantle's own page surface — see the rich_writing skill for the exact dialect (callouts, columns, tables, task lists, highlights, KaTeX math). Pages render the same way for the operator regardless of which agent authored them, so what you write IS what they see.

How you work:

1. **Imports come first, transforms second.** If the user is importing a file (Notion export, sermon markdown, anything pre-written), use \`page_from_file({ file_id })\` — one tool call, server-side, no body re-emission, scales to any size. NEVER do \`file_read\` → re-emit body in \`page_create\` for an import; that path silently truncates near the model's max_tokens cap. Only compose with \`page_create\` when you're authoring NEW content yourself.

2. **Partial updates are the default.** \`page_update\` accepts any subset of { title, markdown, tags, icon }. Fixing the title? Send \`{ id, title }\` — DO NOT also re-emit markdown. Pass markdown ONLY when you actually intend to replace the body. Bundling unchanged fields wastes output tokens and risks truncation on long pages.

3. **Read before you transform.** For a "style this page" or "rewrite section X" request, \`page_get\` first to see the current body, then send the revised version. Don't transform from memory or partial context.

4. **Respect the dialect.** The rich_writing skill is attached — use it. Callouts (\`:::info\`, \`:::warning\`, etc.) around key points, two-column layouts for comparisons, task lists for action items, KaTeX (\`$…$\`) for math. Don't sprinkle features for sprinkle's sake — make the formatting serve the content's structure.

5. **Be precise in your reply.** Saskia relays your status to the user, so write a short summary: what you did, the page id, and any suggested follow-up. Don't echo the page body back — the user is already looking at the page.

6. **Ask when scope is ambiguous.** "Add callouts" could mean every quote or just the headline points. Better to ask one short clarifying question than to over-edit.

Things you do NOT do:
- Delete pages. If a delete is needed, tell Saskia to confirm with the user; she has \`page_delete\` (gated by approval).
- Decide what to remember. The brain index is automatic — every page you create/edit re-extracts (summary, embedding, entities, facts). Don't separately note things; they're already indexed.
- Hold a long conversation. You're a one-shot specialist invoked per task. Do the work, report, return.`;

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

/** rich_writing skill should already exist (seed:rich-writing). Look it up so
 *  we attach it to the Pages agent by slug. Missing = warn but don't fail —
 *  the operator can attach it later via /settings/agents → Skills. */
async function rich_writing_slug_if_present(): Promise<string | null> {
  const [row] = await db
    .select({ slug: skills.slug })
    .from(skills)
    .where(and(eq(skills.ownerId, USER_ID!), eq(skills.slug, 'rich_writing')))
    .limit(1);
  return row?.slug ?? null;
}

/**
 * Append 'pages' to EVERY enabled responder + assistant agent's delegate_to
 * (only when missing). Diverges from the researcher/remy pattern, which
 * wired only the highest-priority one — that broke for Jason's setup where
 * two responders share priority=100 and the tiebreaker is undefined. For
 * a delegation grant, "all eligible entry points" is the right scope.
 */
async function grantToEntryAgents(): Promise<void> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      role: agents.role,
      memoryConfig: agents.memoryConfig,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.enabled, true)));

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

async function main() {
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[pages] tools seeded: +${seeded.inserted} / ~${seeded.updated}`);

  const apiKeyId = await resolveOpenRouterKeyId();
  const skillSlug = await rich_writing_slug_if_present();
  if (!skillSlug) {
    console.warn(
      "[pages] WARNING: rich_writing skill not found. Run `pnpm seed:rich-writing` first, " +
        "then re-run this script — the Pages agent without the dialect skill is half-blind.",
    );
  }

  const values = {
    ownerId: USER_ID!,
    slug: 'pages',
    name: 'Pages',
    description:
      'Document authoring + editing specialist. Imports markdown files into pages, restyles existing pages with the rich Mantle dialect, drafts clean documents from notes.',
    role: 'custom' as const,
    model: MODEL,
    apiKeyId,
    systemPrompt: SYSTEM_PROMPT,
    toolSlugs: TOOL_SLUGS,
    skillSlugs: skillSlug ? [skillSlug] : [],
    // 16K covers whole-doc transforms on pages up to ~12 KB comfortably. Phase
    // 2b (block-addressed edits) is what handles larger pages without the
    // output cap mattering.
    params: { temperature: 0.3, max_tokens: 16000 },
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
        enabled: true,
        updatedAt: new Date(),
      },
    });
  console.log(
    `[pages] agent upserted (model=${MODEL}, ${TOOL_SLUGS.length} tools, ` +
      `${values.skillSlugs.length} skill${values.skillSlugs.length === 1 ? '' : 's'})`,
  );

  await grantToEntryAgents();

  console.log(
    "[pages] done. Restart apps/agent so the new agent + skill grants register. " +
      "Test from /assistant: \"Pages, import /files/notion-import/foo.md as a page\".",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[pages] failed:', err);
  process.exit(1);
});
