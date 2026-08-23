import { randomUUID } from 'node:crypto';
import type { AgentDTO } from '@mantle/client-types';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  agents,
  channels,
  applyPersonaUpdate,
  noteRef,
  type Agent,
  type AgentAvatar,
  type AgentMemoryConfig,
  type AgentParams,
  type PersonaNote,
} from '@mantle/db';
import { CHATTABLE_ROLES } from '@mantle/assistant-runtime';
import { MANIFEST_AGENTS } from './system-manifest/manifest';
import { cloneAgentFields, slugifyAgentName, uniqueAgentSlug } from './agent-clone';

/**
 * Server-side CRUD wrapper for the `agents` table. Every call is owner-scoped
 * — pass the user's id explicitly; never trust client-supplied user ids. The
 * /api/agents/* routes are the only callers.
 */

/**
 * The summary the CRUD layer returns and `GET /api/agents` serializes. Aliased
 * to the wire DTO in `@mantle/client-types` so the server shape and the client
 * consumer can't drift — if `toSummary` stops matching the contract, this file
 * stops compiling. Dates are ISO strings (see `toSummary`).
 */
export type AgentSummary = AgentDTO;

/** Slugs whose prompt/model/params the boot reconcile force-syncs back to the
 *  manifest on upgrade (`syncSpecialistDefs` — specialists with a manifest
 *  prompt; the persona is operator-owned). Surfaced on the DTO so the UI can
 *  warn that an operator model change on these agents will be reverted. */
const DEF_SYNCED_SLUGS = new Set(
  MANIFEST_AGENTS.filter((a) => !a.isPersona && a.systemPrompt).map((a) => a.slug),
);

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
    backupProvider: a.backupProvider,
    backupModel: a.backupModel,
    backupApiKeyId: a.backupApiKeyId,
    backupEnabled: a.backupEnabled,
    baseUrl: a.baseUrl,
    viaTailnet: a.viaTailnet,
    backupBaseUrl: a.backupBaseUrl,
    backupViaTailnet: a.backupViaTailnet,
    ttsWorkerId: a.ttsWorkerId ?? null,
    systemPrompt: a.systemPrompt,
    skillSlugs: a.skillSlugs ?? [],
    toolGroupSlugs: a.toolGroupSlugs ?? [],
    memoryConfig: a.memoryConfig ?? {},
    params: a.params ?? {},
    avatar: a.avatar ?? null,
    personaNotes: (a.personaNotes ?? []) as PersonaNote[],
    assignedUserId: a.assignedUserId ?? null,
    // Deleting a login nulls assigned_user_id via the FK but can't touch
    // assigned_at, so the row can carry a timestamp for an assignment that no
    // longer exists. Derive rather than expose that: the DTO must never say
    // "assigned at X" while saying "assigned to nobody", or a future reader
    // keying off assignedAt alone inherits the inconsistency.
    assignedAt: a.assignedUserId ? (a.assignedAt?.toISOString() ?? null) : null,
    priority: a.priority,
    enabled: a.enabled,
    manifestManaged: DEF_SYNCED_SLUGS.has(a.slug),
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

/**
 * Every agent for the owner as `{slug, name, role}`, ordered by slug — the
 * catalogue the heartbeat form's agent selector renders. Unlike `listAgents`
 * this is NOT filtered to conversational roles (a heartbeat can target any).
 */
export function listAgentOptions(
  userId: string,
): Promise<{ slug: string; name: string; role: Agent['role'] }[]> {
  return db
    .select({ slug: agents.slug, name: agents.name, role: agents.role })
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(agents.slug);
}

/** One owner-scoped agent by its slug (the persona lookup), or null. */
export async function getAgentBySlug(userId: string, slug: string): Promise<AgentSummary | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.slug, slug), eq(agents.ownerId, userId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Agents that can actually deliver a reminder — an enabled agent with an enabled
 * Telegram channel (docs/comms-channels.md). The profile page lets the operator
 * pick one as the event-reminder sender. Distinct, ordered by name.
 */
export function listReminderCapableAgents(
  userId: string,
): Promise<{ slug: string; name: string }[]> {
  return db
    .selectDistinct({ slug: agents.slug, name: agents.name })
    .from(agents)
    .innerJoin(channels, eq(channels.agentId, agents.id))
    .where(
      and(
        eq(agents.ownerId, userId),
        eq(agents.enabled, true),
        eq(channels.type, 'telegram'),
        eq(channels.enabled, true),
      ),
    )
    .orderBy(agents.name);
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
  backupProvider?: string | null;
  backupModel?: string | null;
  backupApiKeyId?: string | null;
  backupEnabled?: boolean;
  baseUrl?: string | null;
  viaTailnet?: boolean;
  backupBaseUrl?: string | null;
  backupViaTailnet?: boolean;
  /** Pinned TTS worker (migration 0066). null = use the default TTS worker. */
  ttsWorkerId?: string | null;
  systemPrompt: string;
  skillSlugs?: string[];
  toolGroupSlugs?: string[];
  memoryConfig?: AgentMemoryConfig;
  params?: AgentParams;
  avatar?: AgentAvatar | null;
  priority?: number;
  enabled?: boolean;
};

/** `db`, or a transaction handle standing in for it. Lets a caller compose
 *  several writes atomically without re-implementing the insert mapping (the
 *  pattern `packages/agent-runtime/src/conversation.ts` uses). */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createAgent(
  userId: string,
  input: CreateAgentInput,
  tx: Executor = db,
): Promise<AgentSummary> {
  const [row] = await tx
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
      backupProvider: input.backupProvider ?? null,
      backupModel: input.backupModel ?? null,
      backupApiKeyId: input.backupApiKeyId ?? null,
      backupEnabled: input.backupEnabled ?? false,
      baseUrl: input.baseUrl ?? null,
      viaTailnet: input.viaTailnet ?? false,
      backupBaseUrl: input.backupBaseUrl ?? null,
      backupViaTailnet: input.backupViaTailnet ?? false,
      ttsWorkerId: input.ttsWorkerId ?? null,
      systemPrompt: input.systemPrompt,
      skillSlugs: input.skillSlugs ?? [],
      toolGroupSlugs: input.toolGroupSlugs ?? [],
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
  if (patch.backupProvider !== undefined) next.backupProvider = patch.backupProvider;
  if (patch.backupModel !== undefined) next.backupModel = patch.backupModel;
  if (patch.backupApiKeyId !== undefined) next.backupApiKeyId = patch.backupApiKeyId;
  if (patch.backupEnabled !== undefined) next.backupEnabled = patch.backupEnabled;
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
  if (patch.viaTailnet !== undefined) next.viaTailnet = patch.viaTailnet;
  if (patch.backupBaseUrl !== undefined) next.backupBaseUrl = patch.backupBaseUrl;
  if (patch.backupViaTailnet !== undefined) next.backupViaTailnet = patch.backupViaTailnet;
  if (patch.ttsWorkerId !== undefined) next.ttsWorkerId = patch.ttsWorkerId;
  if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt;
  if (patch.skillSlugs !== undefined) next.skillSlugs = patch.skillSlugs;
  if (patch.toolGroupSlugs !== undefined) next.toolGroupSlugs = patch.toolGroupSlugs;
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

/* ---------------------------------------------------------------------------
 * Per-login assistants (migration 0143).
 *
 * `agents.assigned_user_id` binds an agent to ONE co-admin login and makes it
 * that login's default chat target. Since `assistant_messages` is keyed
 * (owner_id, agent_id) — and the live NOTIFY payload, read cursors, digests and
 * the inbox all key off the agent too — that single pointer is what stops two
 * people typing at once from landing in one interleaved thread.
 *
 * Thread separation, NOT privacy: `userId` here is still the anchor, every
 * agent stays visible to every login, and replay_window replays any of them.
 * ------------------------------------------------------------------------- */

/**
 * The agent row assigned to a given LOGIN (`actor.id`), or null.
 *
 * Owner-scoped, enabled-only (a disabled assistant falls the caller back to the
 * brain default rather than dead-ending them) and chattable-only — the role gate
 * on creation should make that redundant, but this is the read every turn goes
 * through, so it fails safe against a row that predates the gate or was edited
 * to a worker role afterwards.
 *
 * Returns the ROW, not the DTO: this is the resolution path, and its callers
 * need the same `Agent` the runtime resolver returns. `getAssignedAgentSummary`
 * is the DTO-shaped wrapper for the routes that serialize it.
 */
export async function getAssignedAgent(userId: string, actorId: string): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, userId),
        eq(agents.assignedUserId, actorId),
        eq(agents.enabled, true),
        inArray(agents.role, CHATTABLE_ROLES),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** `getAssignedAgent` as the wire DTO. */
export async function getAssignedAgentSummary(
  userId: string,
  actorId: string,
): Promise<AgentSummary | null> {
  const row = await getAssignedAgent(userId, actorId);
  return row ? toSummary(row) : null;
}

/** Thrown by `cloneAgentForUser` for a bad request (unknown or un-chattable
 *  source), so the routes can answer 400 rather than treating every failure as
 *  a 500. */
export class CloneAgentError extends Error {}

/**
 * Clone `sourceAgentId` into a personal assistant for `actorId`.
 *
 * What is and isn't inherited lives in `cloneAgentFields` (pure, unit-tested);
 * this is the DB half — resolve the source, mint a free slug, insert via the
 * one `createAgent` path, then stamp the assignment.
 *
 * ONE TRANSACTION, and that matters in both directions:
 *
 *   - Releasing the login's previous assistant has to happen first, or the
 *     partial unique index trips. Outside a transaction, a failure after the
 *     release (a slug race, a rejected insert) would leave the login with NO
 *     assistant and no error path back to the one it had.
 *   - The free-slug read and the insert that consumes it are otherwise a
 *     check-then-act race between two concurrent creates.
 *
 * The role gate is the correctness boundary the UI's narrower filter sits on
 * top of: only an agent that can actually take a web turn may be cloned.
 * Cloning a `worker` template (model `'inherit'`) or a summarizer would mint a
 * default chat agent that cannot answer, and — since the assignment lookup
 * doesn't filter by role — the login would land on it every time.
 */
export async function cloneAgentForUser(
  userId: string,
  input: { actorId: string; actorEmail: string; name: string; sourceAgentId: string },
): Promise<AgentSummary> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.sourceAgentId), eq(agents.ownerId, userId)))
      .limit(1);
    if (!source) {
      throw new CloneAgentError(`source agent ${input.sourceAgentId} not found`);
    }
    if (!(CHATTABLE_ROLES as readonly string[]).includes(source.role)) {
      throw new CloneAgentError(
        `agent '${source.slug}' is a ${source.role}, which can't answer a chat turn`,
      );
    }

    const taken = await tx
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.ownerId, userId));
    const slug = uniqueAgentSlug(
      slugifyAgentName(input.name),
      taken.map((r) => r.slug),
    );

    await tx
      .update(agents)
      .set({ assignedUserId: null, assignedAt: null, updatedAt: new Date() })
      .where(and(eq(agents.ownerId, userId), eq(agents.assignedUserId, input.actorId)));

    const created = await createAgent(
      userId,
      cloneAgentFields(toSummary(source), {
        name: input.name,
        slug,
        assignedUserEmail: input.actorEmail,
      }),
      tx,
    );
    const [assigned] = await tx
      .update(agents)
      .set({ assignedUserId: input.actorId, assignedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agents.id, created.id), eq(agents.ownerId, userId)))
      .returning();
    if (!assigned) throw new Error('failed to assign the cloned agent');
    return toSummary(assigned);
  });
}

/** Drop a login's assignment. The agent and its whole archive survive — it just
 *  becomes a shared agent again (same reasoning as migration 0127). Returns the
 *  released agent, or null when the login had none. */
export async function releaseAssignedAgent(
  userId: string,
  actorId: string,
): Promise<AgentSummary | null> {
  const [row] = await db
    .update(agents)
    .set({ assignedUserId: null, assignedAt: null, updatedAt: new Date() })
    .where(and(eq(agents.ownerId, userId), eq(agents.assignedUserId, actorId)))
    .returning();
  return row ? toSummary(row) : null;
}

/** Rename an already-assigned assistant in place (keeps its slug, and therefore
 *  its thread — the client keys threads by slug). Null when unassigned. */
export async function renameAssignedAgent(
  userId: string,
  actorId: string,
  name: string,
): Promise<AgentSummary | null> {
  const [row] = await db
    .update(agents)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(agents.ownerId, userId), eq(agents.assignedUserId, actorId)))
    .returning();
  return row ? toSummary(row) : null;
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
  return mutatePersonaNotes(
    userId,
    id,
    (notes) =>
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
  return mutatePersonaNotes(
    userId,
    id,
    (notes) =>
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
  return mutatePersonaNotes(
    userId,
    id,
    (notes) =>
      applyPersonaUpdate(notes, { removeRefs: [ref] }, new Date().toISOString(), randomUUID())
        .notes,
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
