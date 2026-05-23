/**
 * Seed "Researcher" — Jason's outward-facing agent (Remy's twin). Where Remy
 * goes inward into the conversation archive, Researcher goes out to the live
 * internet: it plans queries, calls `web_search` (Perplexity Sonar via
 * OpenRouter), cross-checks sources, and hands a synthesised, cited answer back
 * to Saskia.
 *
 * Division of labour (per the "Saskia decides" capture model):
 *   - researcher  → web_search + search_nodes/node_read; returns a synthesis.
 *                   Does NOT persist — keeps it focused on finding answers.
 *   - Saskia      → gets the synthesis, decides if it's worth keeping, and
 *                   saves it with `note_create` (which the extractor indexes
 *                   into the brain).
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:researcher
 *
 * Idempotent: upserts the agent by (owner, slug='researcher'), appends
 * 'researcher' to each entry-point agent's delegate_to, and grants them
 * note_create — only when missing.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, agents, apiKeys, type AgentMemoryConfig } from '@mantle/db';
import { seedBuiltinTools } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const MODEL = process.env.RESEARCHER_MODEL || 'anthropic/claude-sonnet-4.6';

const TOOL_SLUGS = [
  'web_search',
  // Check what the user already knows before going to the open web.
  'search_nodes',
  'node_read',
];

const SYSTEM_PROMPT = `You are "Researcher" — Jason's research analyst. You answer questions that need information from the live internet, and you do it rigorously.

You are invoked by Saskia (the main assistant) when a question needs current, external, or verifiable information beyond what's already known.

How you work:
1. First consider whether the answer is already in Jason's own Mantle — a quick \`search_nodes\` can save a web round-trip and ground you in his context. Don't over-do this; one check is usually enough.
2. Plan focused \`web_search\` queries. Prefer several sharp queries over one vague one. Cross-check important claims against more than one search rather than trusting a single result. Use the \`recency\` argument for time-sensitive questions.
3. Synthesise. Produce a clear, direct answer to the question, then the key supporting findings. Note disagreement or uncertainty between sources honestly — don't paper over conflicting information.
4. Always cite. End with a "Sources" list of the URLs you actually relied on (from the web_search citations). Never present a claim as fact without a source behind it; if you couldn't verify something, say so.

How you answer:
- Be thorough but tight — Saskia will relay your synthesis to the user, so write it as the finished answer, not as a tool log.
- Don't fabricate URLs, quotes, or figures. If the web didn't give you something, say what's missing.
- You don't save anything yourself — Saskia decides whether your findings are worth keeping. Just return the best answer you can with its sources.`;

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

/**
 * On one entry-point agent (responder/assistant): append 'researcher' to
 * delegate_to and 'note_create' to tool_slugs, both only if missing. The
 * note_create grant is what lets Saskia persist a research finding she's
 * decided to keep.
 */
async function grantToEntryAgent(role: 'responder' | 'assistant'): Promise<void> {
  const [agent] = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      memoryConfig: agents.memoryConfig,
      toolSlugs: agents.toolSlugs,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.role, role), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  if (!agent) {
    console.log(`[researcher] no enabled ${role} found — skip wiring for ${role}`);
    return;
  }

  const mc = (agent.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
  const delegateTo = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
  const tools = Array.isArray(agent.toolSlugs) ? agent.toolSlugs : [];

  const nextDelegate = delegateTo.includes('researcher')
    ? delegateTo
    : [...delegateTo, 'researcher'];
  const nextTools = tools.includes('note_create') ? tools : [...tools, 'note_create'];

  const delegateChanged = nextDelegate !== delegateTo;
  const toolsChanged = nextTools !== tools;
  if (!delegateChanged && !toolsChanged) {
    console.log(`[researcher] ${agent.slug} (${role}) already wired`);
    return;
  }

  await db
    .update(agents)
    .set({
      memoryConfig: { ...mc, delegate_to: nextDelegate },
      toolSlugs: nextTools,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agent.id));
  console.log(
    `[researcher] ${agent.slug} (${role}): ` +
      `${delegateChanged ? "+delegate_to 'researcher' " : ''}${toolsChanged ? "+tool 'note_create'" : ''}`.trim(),
  );
}

async function main() {
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[researcher] tools seeded: +${seeded.inserted} / ~${seeded.updated}`);

  const apiKeyId = await resolveOpenRouterKeyId();

  const values = {
    ownerId: USER_ID!,
    slug: 'researcher',
    name: 'Researcher',
    description: 'Outward-facing research agent — searches the live web (Sonar) and synthesises cited answers.',
    role: 'custom' as const,
    model: MODEL,
    apiKeyId,
    systemPrompt: SYSTEM_PROMPT,
    toolSlugs: TOOL_SLUGS,
    skillSlugs: [],
    params: { temperature: 0.3 },
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
        params: values.params,
        enabled: true,
        updatedAt: new Date(),
      },
    });
  console.log(`[researcher] agent upserted (model=${MODEL}, ${TOOL_SLUGS.length} tools incl. web_search)`);

  await grantToEntryAgent('responder');
  await grantToEntryAgent('assistant');

  console.log('[researcher] done. Restart apps/agent so web_search / note_create register in the running process.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[researcher] failed:', err);
  process.exit(1);
});
