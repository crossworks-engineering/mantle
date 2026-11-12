/**
 * The subject box's `agentModel` case (phase 4, the first fleet write,
 * docs/control-center.md "Set an agent's model on the fleet"): the model
 * of one agent the system ships, as the Agents screen sets it. A case on
 * the signed route like the others (box.ts), so the same two checks hold
 * it and no agent, MCP client or API key on the box reaches it.
 *
 * Its checks inside it, no more:
 *  1. the slug is one the system ships (the manifest's, the slugs the
 *     matrix names), and the row with that slug is the shipped one, not a
 *     person's own assistant;
 *  2. when the change names its source route (a CC from this release
 *     does, copying a model from another box), the agent runs on that
 *     provider and endpoint (endpoint.ts): a model id means something on
 *     one route only (`route`);
 *  3. the box's model policy allows the route as it will be (the Agents
 *     screen's own check, lib/model-policy-save.ts).
 * Then the Agents screen's own update (updateAgent), the model field only:
 * the provider, its key and base URL stay, so no chat moves to another
 * provider. The box's audit row is written by the route (box.ts).
 */
import { agents, and, db, eq, isNull } from '@mantle/db';
import { updateAgent } from '@/lib/agents';
import { modelPolicyIssue } from '@/lib/model-policy-save';
import { MANIFEST_AGENTS } from '@/lib/system-manifest/manifest';
import { endpointPrint } from './endpoint';

/** What an agentModel call answers: the slug, ok and the model it had, or
 *  one fixed reason. Never the policy's text. */
export type AgentModelAnswer = {
  slug: string;
  ok: boolean;
  /** The model before the call (ok), or now (not ok). */
  was?: string;
  reason?: 'agent' | 'route' | 'policy';
};

const SHIPPED = new Set(MANIFEST_AGENTS.map((a) => a.slug));

export async function setAgentModel(
  ownerId: string,
  slug: string,
  model: string,
  route?: { provider: string; endpoint: string },
): Promise<AgentModelAnswer> {
  if (!SHIPPED.has(slug)) return { slug, ok: false, reason: 'agent' };
  const [row] = await db
    .select({
      id: agents.id,
      provider: agents.provider,
      model: agents.model,
      baseUrl: agents.baseUrl,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug), isNull(agents.assignedUserId)))
    .limit(1);
  if (!row) return { slug, ok: false, reason: 'agent' };
  if (route && (row.provider !== route.provider || endpointPrint(row.baseUrl) !== route.endpoint)) {
    return { slug, ok: false, was: row.model, reason: 'route' };
  }
  if (modelPolicyIssue(row.provider, model, row.baseUrl)) {
    return { slug, ok: false, was: row.model, reason: 'policy' };
  }
  if (row.model === model) return { slug, ok: true, was: row.model };
  const done = await updateAgent(ownerId, row.id, { model });
  return done ? { slug, ok: true, was: row.model } : { slug, ok: false, reason: 'agent' };
}
