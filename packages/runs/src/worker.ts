/**
 * The default worker agent — a TEMPLATE, not a resident process (plan §6/§6b:
 * "agents are templates; run items are the executions"). Each `worker_invoke`
 * item spawns a fresh agent turn from this configuration: model, kit,
 * instructions. Parallel capacity never requires more agents; adding one
 * never auto-fans-out (the roster is a routing table, not a broadcast list).
 *
 * The definition constants below (slug / prompt / tool groups / model
 * sentinel) are the SINGLE SOURCE for this template. Slice 4 WP-E moved the
 * template into the system manifest: `MANIFEST_AGENTS` now carries a `worker`
 * entry that IMPORTS these constants (apps/web/lib/system-manifest/manifest.ts),
 * so onboarding + the boot reconcile seed the row on every brain. The `runs`
 * tool group is still NOT attached to the persona while the feature dogfoods,
 * so seeding a dormant worker template changes nothing until a run invokes it.
 * `ensureWorkerAgent` below stays the LAZY fallback: it finds the
 * manifest-seeded row by slug (no duplicate), or creates it if a run fires on a
 * brain that has not reconciled yet.
 *
 * Model inheritance: `model = 'inherit'` (the sentinel below) means "run on
 * the responder's model/provider/key at execution time" — the DEFAULT. The
 * out-of-box win is structural (traceable runs + fresh-context audit), not
 * cost arbitrage; pointing a worker at a cheaper model is the opt-in knob,
 * justified later by its acceptance rate.
 */
import { and, eq } from 'drizzle-orm';
import { agents, type Agent, type Db } from '@mantle/db';

/** Sentinel model value: resolve to the responder's route at execution time.
 *  (agents.model is NOT NULL by long-standing schema; a nullable model would
 *  ripple string|null through every chat path for this one consumer.) */
export const WORKER_MODEL_INHERIT = 'inherit';

export const DEFAULT_WORKER_SLUG = 'worker';

/** Propose-don't-mutate kit: read/search only. No write groups, no run
 *  tools, no delegation — enforced by grant AND by executing at delegation
 *  depth 2 (run_* / invoke_agent refuse there). */
export const WORKER_TOOL_GROUP_SLUGS = ['memory-core'];

export const WORKER_SYSTEM_PROMPT = `You are a worker agent: you execute ONE delegated step of a larger run and return an evidence-bearing proposal. You never apply changes yourself — you research, draft, and propose; a separate audit judges your work and a specialist or the responder executes it.

Rules:
- Ground every claim in work you actually did THIS turn (searches run, sections read). Your tool calls are recorded mechanically and audited against your claims — never say "verified" or "confirmed" about anything you did not check with a tool here.
- Stay on the assigned step. Do not expand scope, do not start side quests.
- If the step cannot be completed (missing data, ambiguous ask), say so plainly and propose the smallest unblocking question.

Reply structure (markdown, in this order):
## Proposal
The deliverable for the step: the draft, the answer, the plan — concrete and complete.
## Evidence
What you consulted and what it showed, briefly (the runtime also records your tool calls; this section is your reading of them).
## Self-assessment
Confidence, gaps, and anything the audit should double-check.`;

/** Find the worker agent to run: an explicit id if given, else the first
 *  enabled role='worker' row, else create the default template. */
export async function ensureWorkerAgent(
  db: Db,
  ownerId: string,
  agentId?: string | null,
): Promise<Agent | null> {
  if (agentId) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (row && row.ownerId === ownerId && row.enabled && row.role === 'worker') return row;
    return null; // explicit ref that no longer resolves — caller fails the item
  }
  const [existing] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.role, 'worker'), eq(agents.enabled, true)))
    .orderBy(agents.createdAt)
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(agents)
    .values({
      ownerId,
      slug: DEFAULT_WORKER_SLUG,
      name: 'Worker agent',
      description:
        'Default runner-queue worker: executes delegated run steps and returns evidence-bearing proposals. Duplicate and set a cheaper model to opt into cost arbitrage.',
      role: 'worker',
      model: WORKER_MODEL_INHERIT,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      toolGroupSlugs: [...WORKER_TOOL_GROUP_SLUGS],
      enabled: true,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Slug collision with an operator row (or a concurrent ensure) — re-read.
  const [again] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.role, 'worker'), eq(agents.enabled, true)))
    .limit(1);
  return again ?? null;
}

/** List enabled worker agents (plan-time routing validation). */
export async function listWorkerAgents(db: Db, ownerId: string): Promise<Agent[]> {
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.role, 'worker'), eq(agents.enabled, true)));
}
