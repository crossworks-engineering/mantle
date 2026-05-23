/**
 * Seed "Remy" — Jason's memory-recall agent. Where Saskia lives in the present
 * turn, Remy travels backward: given a vague ask ("last week we discussed some
 * Bible topic, recall the exact conclusion"), Remy locates WHEN via conversation
 * digests (`find_window`), pulls the raw turns (`recall_window`), reasons over
 * them, and hands a faithful synthesis back to Saskia.
 *
 * Reached via delegation — this script also adds `remy` to the enabled
 * responder's and assistant's `memory_config.delegate_to` so the path works
 * immediately.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:remy
 *
 * Idempotent: upserts the agent by (owner, slug='remy') and only appends to
 * each entry-point agent's delegate_to if missing.
 *
 * NOTE: Remy is an `agents` row, NOT an `ai_workers` row — recall needs a tool
 * loop (call find_window, call recall_window, reason, re-pull a wider window if
 * the answer isn't there). `invoke_agent` only resolves targets from `agents`.
 * Remy runs at delegation depth 2 (MAX_AGENT_DEPTH), so it cannot sub-delegate;
 * it iterates over sub-ranges itself instead. Hence no `delegate_to` for Remy.
 */

import { and, desc, eq } from 'drizzle-orm';
import { db, agents, apiKeys, type AgentMemoryConfig } from '@mantle/db';
import { seedBuiltinTools } from '@mantle/tools';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('ALLOWED_USER_ID env var required');
  process.exit(1);
}

const MODEL = process.env.REMY_MODEL || 'anthropic/claude-sonnet-4.6';

const TOOL_SLUGS = [
  'find_window',
  'recall_window',
  // Fallbacks: pull a specific digest/note by id, or keyword-search when the
  // vector locate misses.
  'search_nodes',
  'node_read',
];

const SYSTEM_PROMPT = `You are "Remy" — Jason's memory. Your one job is to recall past conversations precisely and faithfully when asked.

You are invoked by Saskia (the main assistant) when the user wants to revisit something that was discussed before but doesn't remember exactly what was said or concluded. You have direct, lossless access to the conversation archive.

How you work:
1. If the ask is vague about timing ("last week", "a while back", "the Bible topic"), call \`find_window\` with the topic (and a rough date range if the user hinted one) to locate candidate time windows. The windows come from conversation digests — short summaries that act as your index.
2. Read the candidate summaries, pick the most likely window, and call \`recall_window\` with its period_start and period_end to pull the ACTUAL raw turns of that conversation.
3. If \`recall_window\` reports the result was truncated, the span is too big for one pull — narrow the range or walk it in sub-ranges, reasoning over each, rather than trusting a partial slice.
4. If the user already gave a date ("what did we say on Tuesday?"), skip \`find_window\` and call \`recall_window\` directly.

How you answer:
- Lead with WHEN it happened and WHAT the topic was, then the actual substance — especially the conclusion or decision, since that's usually what the user is reaching for.
- Quote the real words for anything that matters; you have the verbatim turns, so don't paraphrase a key conclusion into something fuzzy.
- Be faithful. If you cannot find the discussion, say so plainly and report what you searched and the windows you considered — never invent a recollection.
- You recall the DIALOGUE that was exchanged, not anyone's private reasoning. Don't fabricate intent that wasn't said.
- Hand back a tight, self-contained synthesis: Saskia will relay it to the user, so write it as the recalled answer, not as a tool report.`;

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

/** Append `remy` to one entry-point agent's delegate_to if missing. */
async function wireDelegation(role: 'responder' | 'assistant'): Promise<void> {
  const [agent] = await db
    .select({ id: agents.id, slug: agents.slug, memoryConfig: agents.memoryConfig })
    .from(agents)
    .where(and(eq(agents.ownerId, USER_ID!), eq(agents.role, role), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority))
    .limit(1);
  if (!agent) {
    console.log(`[remy] no enabled ${role} found — skip delegation wiring for ${role}`);
    return;
  }
  const mc = (agent.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
  const current = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
  if (current.includes('remy')) {
    console.log(`[remy] ${agent.slug} (${role}) already delegates to 'remy'`);
    return;
  }
  await db
    .update(agents)
    .set({ memoryConfig: { ...mc, delegate_to: [...current, 'remy'] }, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));
  console.log(`[remy] added 'remy' to ${agent.slug} (${role}).delegate_to → delegation enabled`);
}

async function main() {
  // Ensure the builtin tool rows (incl. find_window / recall_window) exist for
  // this owner so the grant resolves even before the next agent boot.
  const seeded = await seedBuiltinTools(USER_ID!);
  console.log(`[remy] tools seeded: +${seeded.inserted} / ~${seeded.updated}`);

  const apiKeyId = await resolveOpenRouterKeyId();

  const values = {
    ownerId: USER_ID!,
    slug: 'remy',
    name: 'Remy',
    description: 'Memory-recall agent — replays past conversations from the archive on demand.',
    role: 'custom' as const,
    model: MODEL,
    apiKeyId,
    systemPrompt: SYSTEM_PROMPT,
    toolSlugs: TOOL_SLUGS,
    skillSlugs: [],
    // Low temperature: recall should be faithful, not creative.
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
  console.log(`[remy] agent upserted (model=${MODEL}, ${TOOL_SLUGS.length} tools)`);

  // Wire delegation from both entry-point surfaces so "recall …" works on
  // Telegram (responder) and on the web /assistant.
  await wireDelegation('responder');
  await wireDelegation('assistant');

  console.log('[remy] done. Restart apps/agent so find_window / recall_window are registered in the running process.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[remy] failed:', err);
  process.exit(1);
});
