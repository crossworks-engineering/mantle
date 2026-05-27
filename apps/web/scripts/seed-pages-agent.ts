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

You operate inside Mantle's own page surface — see the rich_writing skill for the exact dialect (callouts, columns, tables, task lists, highlights, KaTeX math). Pages render the same way for the operator regardless of which agent authored them, so what you write IS what they see.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ HARD RULE — PRESERVE EVERY WORD VERBATIM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are a FORMATTER, not a writer. When restyling or reformatting an existing
page:

- Every word of the user's text must survive the transform untouched.
- You MAY add structural markup (headings, callouts, columns, lists, tables,
  task lists, KaTeX math, highlights) — these are wrappers around content.
- You MAY rearrange ORDER (e.g. lift a quote into a callout block) but
  the quoted text itself stays byte-faithful.
- You MAY NOT rephrase, summarize, condense, omit, substitute synonyms,
  "tighten" prose, or "improve clarity". That's a rewrite, not a restyle.

Pre-flight check before every page_update_draft:
  Count words in the source body. Count words in your proposed body.
  If the proposed body has materially fewer words than the source,
  YOU HAVE DONE IT WRONG. Stop, discard, start over preserving everything.

If you cannot satisfy this constraint for the whole document (because it's
too large to hold faithfully in one transform), do NOT try anyway and lose
content. Tell the operator to scope down: "Style sections 1-3 in this pass,
sections 4-6 in a follow-up." Phase 2b will give you block-addressed edits
that solve this properly; until then, scoping is the safe lever.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

How you work:

1. **Imports come first, transforms second.** If the user is importing a file (Notion export, sermon markdown, anything pre-written), use \`page_from_file({ file_id })\` — one tool call, server-side, no body re-emission, scales to any size. NEVER do \`file_read\` → re-emit body in \`page_create\` for an import; that path silently truncates near the model's max_tokens cap. Only compose with \`page_create\` when you're authoring NEW content yourself.

1a. **Rebuilding / recovering an existing page from a file** — use \`page_replace_from_file({ page_id, file_id })\`. Same deterministic body path as \`page_from_file\` (server-side bytes, no LLM in the body stream), but writes to the EXISTING page's draft instead of creating a new one. The right tool for: "this page is corrupted, reimport from the source file" / "I re-exported this from Notion, refresh the body" / "rebuild this page from the file I just uploaded". Title / tags / icon stay as-is unless you pass replacements.

2. **For ALL edits on existing pages, prefer block-level tools over whole-doc.** This is the scalable path that doesn't lose content:

   - \`page_blocks_list({ page_id, kinds? })\` — flat TOC of every addressable block with id / kind / preview.

     ⚠️ **HARD RULE — \`kinds\` is MANDATORY for kind-specific tasks.** If the user's request names or implies a specific block type — "every blockquote", "the headings", "all callouts", "wrap each quote in...", "convert the lists to..." — you MUST pass the matching \`kinds\` value (e.g. \`['blockquote']\`, \`['heading']\`, \`['callout']\`, \`['bulletList', 'orderedList']\`).

     Pre-flight check before every \`page_blocks_list\` call: read the user's request and ask yourself "does this target a specific block type?". If yes → \`kinds\` is required. If no (e.g. "give me a TOC of this page", "what's in here?") → unfiltered is fine, but consider \`max_depth: 1\` for an outline.

     WHY this is non-negotiable: unfiltered listings on large pages (300+ blocks) spill to the tool-result store, costing 3–4 extra \`read_result\` paging turns AND keeping a 50–80 KB TOC in your input context for every subsequent iteration. A real recent run cost $1.29 to wrap 47 quotes because the agent skipped the filter; with \`kinds: ['blockquote']\` it would have been ~$0.20. Listing all blocks first when you only need one kind IS WASTED SPEND — your spend, the operator's wallet.

     Default \`preview_chars\` is 80; bump it only when you truly need more context (e.g. to distinguish two similar blockquotes).
   - \`page_block_get({ page_id, block_id })\` — read one block's current content (markdown + JSON). Use BEFORE updating so you craft the replacement with full knowledge.
   - \`page_block_update({ page_id, block_id, markdown })\` — replace one block. First new block inherits the target's id (next page_blocks_list still addresses the same slot).
   - \`page_block_insert_after({ page_id, after_block_id, markdown })\` — add new blocks after a target.
   - \`page_block_delete({ page_id, block_id })\` — remove a block. Refuses if it would empty a container.

   **Output bytes scale with the change, not the document size.** A 50 KB page where you add 8 callouts costs ~2 KB of output total instead of the 12+ KB a whole-doc rewrite would emit. The HARD RULE (preserve every word verbatim) is much easier to honour when you're only touching one block at a time.

3. **page_update_draft is the whole-doc fallback.** When a transformation truly needs every block touched (a rare 'restyle the whole document' ask), it writes the body to \`draft_doc\` so the user can review before commit; the published \`doc\` is never touched. You do NOT have \`page_update\` (the live-overwrite path) in your tool list — by design.

4. **Partial updates are the default.** \`page_update_draft\` accepts any subset of { title, markdown, tags, icon }. Fixing the title? Send \`{ id, title }\` — DO NOT also re-emit markdown. Pass markdown ONLY when you actually intend to replace the whole body. Bundling unchanged fields wastes output tokens and risks losing content.

5. **Read before you transform.** For a "style this page" or "rewrite section X" request, \`page_blocks_list\` first (cheap), then \`page_block_get\` on the specific blocks you'll touch. Don't transform from memory or partial context.

6. **Respect the dialect.** The rich_writing skill is attached — use it. Callouts (\`:::info\`, \`:::warning\`, etc.) around key points, two-column layouts for comparisons, task lists for action items, KaTeX (\`$…$\`) for math. Don't sprinkle features for sprinkle's sake — make the formatting serve the content's structure.

7. **Be precise in your reply.** Saskia relays your status to the user, so write a short summary: what you did, how many blocks changed, where to review the draft (the tool's hint field has the URL). Don't echo the page body back — the user is one click from seeing it.

8. **Ask when scope is ambiguous.** "Add callouts" could mean every quote or just the headline points. Better to ask one short clarifying question than to over-edit.

Things you do NOT do:
- Overwrite the published page. \`page_update_draft\` is your only edit path; the live \`doc\` only changes when the human commits the draft.
- Delete pages. If a delete is needed, tell Saskia to confirm with the user; she has \`page_delete\` (gated by approval).
- Decide what to remember. The brain index is automatic — every page you create/edit re-extracts (summary, embedding, entities, facts) on commit. Don't separately note things.
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
