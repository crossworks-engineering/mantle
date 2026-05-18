import { and, desc, eq } from 'drizzle-orm';
import { db, agents, type Agent, type AgentMemoryConfig, type AgentParams } from '@mantle/db';

/**
 * Server-side CRUD wrapper for the `agents` table. Every call is owner-scoped
 * — pass the user's id explicitly; never trust client-supplied user ids. The
 * /api/agents/* routes are the only callers.
 */

export type AgentSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: Agent['role'];
  model: string;
  apiKeyId: string | null;
  systemPrompt: string;
  tools: string[];
  toolSlugs: string[];
  skillSlugs: string[];
  memoryConfig: AgentMemoryConfig;
  params: AgentParams;
  priority: number;
  enabled: boolean;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

function toSummary(a: Agent): AgentSummary {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    role: a.role,
    model: a.model,
    apiKeyId: a.apiKeyId,
    systemPrompt: a.systemPrompt,
    tools: a.tools ?? [],
    toolSlugs: a.toolSlugs ?? [],
    skillSlugs: a.skillSlugs ?? [],
    memoryConfig: a.memoryConfig ?? {},
    params: a.params ?? {},
    priority: a.priority,
    enabled: a.enabled,
    lastUsedAt: a.lastUsedAt?.toISOString() ?? null,
    usageCount: a.usageCount ?? 0,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function listAgents(userId: string): Promise<AgentSummary[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(desc(agents.priority), desc(agents.updatedAt));
  return rows.map(toSummary);
}

export async function getAgent(userId: string, id: string): Promise<AgentSummary | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, userId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

export type CreateAgentInput = {
  slug: string;
  name: string;
  description?: string | null;
  role: Agent['role'];
  model: string;
  apiKeyId: string | null;
  systemPrompt: string;
  tools?: string[];
  toolSlugs?: string[];
  skillSlugs?: string[];
  memoryConfig?: AgentMemoryConfig;
  params?: AgentParams;
  priority?: number;
  enabled?: boolean;
};

export async function createAgent(
  userId: string,
  input: CreateAgentInput,
): Promise<AgentSummary> {
  const [row] = await db
    .insert(agents)
    .values({
      ownerId: userId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      role: input.role,
      model: input.model,
      apiKeyId: input.apiKeyId,
      systemPrompt: input.systemPrompt,
      tools: input.tools ?? [],
      toolSlugs: input.toolSlugs ?? [],
      skillSlugs: input.skillSlugs ?? [],
      memoryConfig: input.memoryConfig ?? {},
      params: input.params ?? {},
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error('failed to insert agent');
  return toSummary(row);
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'slug'>>;

export async function updateAgent(
  userId: string,
  id: string,
  patch: UpdateAgentInput,
): Promise<AgentSummary | null> {
  const next: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.apiKeyId !== undefined) next.apiKeyId = patch.apiKeyId;
  if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt;
  if (patch.tools !== undefined) next.tools = patch.tools;
  if (patch.toolSlugs !== undefined) next.toolSlugs = patch.toolSlugs;
  if (patch.skillSlugs !== undefined) next.skillSlugs = patch.skillSlugs;
  if (patch.memoryConfig !== undefined) next.memoryConfig = patch.memoryConfig;
  if (patch.params !== undefined) next.params = patch.params;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;

  const [row] = await db
    .update(agents)
    .set(next)
    .where(and(eq(agents.id, id), eq(agents.ownerId, userId)))
    .returning();
  return row ? toSummary(row) : null;
}

export async function setEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<AgentSummary | null> {
  return updateAgent(userId, id, { enabled });
}

export async function deleteAgent(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, userId)))
    .returning({ id: agents.id });
  return rows.length > 0;
}
