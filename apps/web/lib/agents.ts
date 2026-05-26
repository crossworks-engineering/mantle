import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  agents,
  applyPersonaUpdate,
  noteRef,
  type Agent,
  type AgentAvatar,
  type AgentMemoryConfig,
  type AgentParams,
  type PersonaNote,
} from '@mantle/db';

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
  /** Provider id — see packages/voice/src/providers.ts. */
  provider: string;
  model: string;
  apiKeyId: string | null;
  systemPrompt: string;
  tools: string[];
  toolSlugs: string[];
  skillSlugs: string[];
  memoryConfig: AgentMemoryConfig;
  params: AgentParams;
  avatar: AgentAvatar | null;
  /** Layer-1 persona: what the agent has *learned* about the user (written by
   *  the reflector + the update_persona tool). Includes the soft-retired audit
   *  tail — the UI filters with activeNotes(). */
  personaNotes: PersonaNote[];
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
    provider: a.provider,
    model: a.model,
    apiKeyId: a.apiKeyId,
    systemPrompt: a.systemPrompt,
    tools: a.tools ?? [],
    toolSlugs: a.toolSlugs ?? [],
    skillSlugs: a.skillSlugs ?? [],
    memoryConfig: a.memoryConfig ?? {},
    params: a.params ?? {},
    avatar: a.avatar ?? null,
    personaNotes: (a.personaNotes ?? []) as PersonaNote[],
    priority: a.priority,
    enabled: a.enabled,
    lastUsedAt: a.lastUsedAt?.toISOString() ?? null,
    usageCount: a.usageCount ?? 0,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Roles that belong on the `/settings/agents` page — conversational
 *  agents that take turns. Worker roles (reflector/extractor/
 *  summarizer) used to live here too, but moved to `ai_workers` —
 *  the `/settings/ai-workers` page is their home now. We filter
 *  them out instead of dropping their rows so a code-path that still
 *  reads the agents table doesn't disappear. */
const CONVERSATIONAL_ROLES = ['responder', 'assistant', 'custom'] as const;

export async function listAgents(userId: string): Promise<AgentSummary[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(desc(agents.priority), desc(agents.updatedAt));
  return rows
    .filter((r) => (CONVERSATIONAL_ROLES as readonly string[]).includes(r.role))
    .map(toSummary);
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
  /** Provider id. Optional on the input — the schema default
   *  ('openrouter') applies when omitted. */
  provider?: string;
  model: string;
  apiKeyId: string | null;
  systemPrompt: string;
  tools?: string[];
  toolSlugs?: string[];
  skillSlugs?: string[];
  memoryConfig?: AgentMemoryConfig;
  params?: AgentParams;
  avatar?: AgentAvatar | null;
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
      provider: input.provider ?? 'openrouter',
      model: input.model,
      apiKeyId: input.apiKeyId,
      systemPrompt: input.systemPrompt,
      tools: input.tools ?? [],
      toolSlugs: input.toolSlugs ?? [],
      skillSlugs: input.skillSlugs ?? [],
      memoryConfig: input.memoryConfig ?? {},
      params: input.params ?? {},
      avatar: input.avatar ?? null,
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
  if (patch.provider !== undefined) next.provider = patch.provider;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.apiKeyId !== undefined) next.apiKeyId = patch.apiKeyId;
  if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt;
  if (patch.tools !== undefined) next.tools = patch.tools;
  if (patch.toolSlugs !== undefined) next.toolSlugs = patch.toolSlugs;
  if (patch.skillSlugs !== undefined) next.skillSlugs = patch.skillSlugs;
  // Shallow-merge memory_config instead of overwriting it. The agents form
  // only round-trips the keys it renders, so a wholesale replace silently
  // drops any key the form doesn't send — most importantly `delegate_to`
  // (the agent-delegation allowlist, set by the seed scripts and the
  // Delegates-to picker). jsonb `||` is a top-level merge with the patch
  // winning, so managed keys update while unmanaged keys survive. Clearing a
  // key still works because the form sends it explicitly (e.g. delegate_to: []).
  if (patch.memoryConfig !== undefined) {
    next.memoryConfig = sql`coalesce(${agents.memoryConfig}, '{}'::jsonb) || ${JSON.stringify(
      patch.memoryConfig,
    )}::jsonb`;
  }
  if (patch.params !== undefined) next.params = patch.params;
  if (patch.avatar !== undefined) next.avatar = patch.avatar;
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

/* ---------------------------------------------------------------------------
 * Persona-note curation (Layer-1 persona, the "what it has learned" half).
 *
 * Notes are normally written by the reflector (passive) and the update_persona
 * tool (in-turn). These let the human operator curate them from
 * /settings/agents. We respect the soft-retire invariant: edits supersede,
 * retire never deletes, restore un-retires — persona has no immutable source
 * to re-derive from, so every change stays reversible.
 * ------------------------------------------------------------------------- */

/** Load+save guard: runs `transform` on the agent's current notes and persists
 *  the result, owner-scoped. Returns the refreshed summary (or null if the
 *  agent isn't this owner's). */
async function mutatePersonaNotes(
  userId: string,
  id: string,
  transform: (notes: PersonaNote[]) => PersonaNote[],
): Promise<AgentSummary | null> {
  const [row] = await db
    .select({ id: agents.id, personaNotes: agents.personaNotes })
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, userId)))
    .limit(1);
  if (!row) return null;
  const next = transform((row.personaNotes ?? []) as PersonaNote[]);
  const [updated] = await db
    .update(agents)
    .set({ personaNotes: next, updatedAt: new Date() })
    .where(eq(agents.id, row.id))
    .returning();
  return updated ? toSummary(updated) : null;
}

export type PersonaNoteKind = PersonaNote['kind'];

/** Add a human-authored note. */
export function addPersonaNote(
  userId: string,
  id: string,
  input: { kind: PersonaNoteKind; content: string },
): Promise<AgentSummary | null> {
  return mutatePersonaNotes(userId, id, (notes) =>
    applyPersonaUpdate(
      notes,
      { add: { kind: input.kind, content: input.content } },
      new Date().toISOString(),
      randomUUID(),
    ).notes,
  );
}

/** Edit a note = supersede the old one with a new note carrying the edited
 *  text (keeps the original in the audit tail). */
export function editPersonaNote(
  userId: string,
  id: string,
  input: { ref: string; kind: PersonaNoteKind; content: string },
): Promise<AgentSummary | null> {
  return mutatePersonaNotes(userId, id, (notes) =>
    applyPersonaUpdate(
      notes,
      { add: { kind: input.kind, content: input.content }, supersedeRefs: [input.ref] },
      new Date().toISOString(),
      randomUUID(),
    ).notes,
  );
}

/** Soft-retire a note (hidden from future turns, kept for audit). */
export function retirePersonaNote(
  userId: string,
  id: string,
  ref: string,
): Promise<AgentSummary | null> {
  return mutatePersonaNotes(userId, id, (notes) =>
    applyPersonaUpdate(notes, { removeRefs: [ref] }, new Date().toISOString(), randomUUID()).notes,
  );
}

/** Un-retire a previously retired note (only the human can do this; the
 *  reflector/tool only ever append or retire). */
export function restorePersonaNote(
  userId: string,
  id: string,
  ref: string,
): Promise<AgentSummary | null> {
  return mutatePersonaNotes(userId, id, (notes) =>
    notes.map((n) => {
      if (noteRef(n) !== ref || !n.retiredAt) return n;
      const { retiredAt, retiredReason, supersededBy, ...rest } = n;
      void retiredAt;
      void retiredReason;
      void supersededBy;
      return rest;
    }),
  );
}
