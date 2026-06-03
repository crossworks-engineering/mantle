/**
 * Seed "Docs" — the documentation agent. Where Researcher goes to the live web
 * and Remy goes into the conversation archive, Docs goes into the indexed
 * documentation: it answers "how does this system work?" by searching the
 * `documentation` nodes and citing them.
 *
 * It reads only — `search_nodes` + `search_chunks` (scoped to the
 * `documentation` branch) to find the right passage, `node_read` to open the
 * whole doc. Saskia delegates to it via `invoke_agent`.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:docs
 *
 * Idempotent: upserts the agent by (owner, slug='docs') and appends 'docs' to
 * each entry-point agent's delegate_to — only when missing. (Indexing itself is
 * opt-in: enable the System docs collection at /docs.)
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, agents, apiKeys, type AgentMemoryConfig } from '@mantle/db';
import { seedBuiltinTools } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const MODEL = process.env.DOCS_MODEL || 'anthropic/claude-sonnet-4.6';

const TOOL_SLUGS = ['search_nodes', 'search_chunks', 'node_read'];

const SYSTEM_PROMPT = `You are "Docs" — the documentation expert for this system (Mantle). You answer questions about how the system works, drawing strictly on its indexed documentation.

You are invoked by Saskia (the main assistant) when a question is about the system itself — its architecture, features, setup, data flow, or how a particular capability works.

How you work:
1. Search the documentation. Use \`search_chunks\` with \`branch='documentation'\` to find the most relevant passages, and/or \`search_nodes\` with \`type='documentation'\` to find the right doc. The docs are real markdown files indexed into the brain.
2. Open the source. Use \`node_read\` on a hit's node id to read the full document when you need more than the matched passage.
3. Answer from what you found — concretely, with specifics (file/section names, exact behaviour). Do not invent features the docs don't describe.
4. Always cite the document(s) you relied on by their title (e.g. "architecture.md", "memory.md").

How you answer:
- Be accurate and tight — Saskia relays your answer to the user, so write it as the finished answer, not a tool log.
- If the documentation doesn't cover something, say so plainly rather than guessing. The docs are the source of truth; don't fill gaps with assumptions.
- You read only — you never modify docs or save anything.`;

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

/** Append 'docs' to one entry-point agent's delegate_to (only if missing). The
 *  parent needs no new tools — the Docs agent owns its own. */
async function grantToEntryAgent(role: 'responder' | 'assistant'): Promise<void> {
  const [agent] = await db
    .select({ id: agents.id, slug: agents.slug, memoryConfig: agents.memoryConfig })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.role, role), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  if (!agent) {
    console.log(`[docs] no enabled ${role} found — skip wiring for ${role}`);
    return;
  }

  const mc = (agent.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
  const delegateTo = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
  if (delegateTo.includes('docs')) {
    console.log(`[docs] ${agent.slug} (${role}) already delegates to docs`);
    return;
  }

  await db
    .update(agents)
    .set({ memoryConfig: { ...mc, delegate_to: [...delegateTo, 'docs'] }, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));
  console.log(`[docs] ${agent.slug} (${role}): +delegate_to 'docs'`);
}

async function main() {
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[docs] tools seeded: +${seeded.inserted} / ~${seeded.updated}`);

  const apiKeyId = await resolveOpenRouterKeyId();

  const values = {
    ownerId: USER_ID!,
    slug: 'docs',
    name: 'Docs',
    description: "Documentation agent — answers how the system works from its indexed docs, with citations.",
    role: 'custom' as const,
    model: MODEL,
    apiKeyId,
    systemPrompt: SYSTEM_PROMPT,
    toolSlugs: TOOL_SLUGS,
    skillSlugs: [],
    params: { temperature: 0.2 },
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
  console.log(`[docs] agent upserted (model=${MODEL}, ${TOOL_SLUGS.length} read tools)`);

  await grantToEntryAgent('responder');
  await grantToEntryAgent('assistant');

  console.log(
    '[docs] done. Enable the System docs collection at /docs, ' +
      'then restart apps/agent so the delegate is live.',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[docs] failed:', err);
  process.exit(1);
});
