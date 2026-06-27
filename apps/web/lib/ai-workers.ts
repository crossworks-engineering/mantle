/**
 * Server-side CRUD + resolution for ai_workers.
 *
 * Conventions:
 *   - `getDefaultWorker(ownerId, kind)` is the runtime hot path. It
 *     returns the row marked is_default=true for the given owner+kind
 *     and falls back to the highest-priority enabled row if no
 *     default is set. Returns null if there are no workers of that
 *     kind — callers decide whether that's fatal.
 *   - `setDefaultWorker` is atomic: clears the prior default in the
 *     same transaction before flipping the new one. Without that,
 *     the partial unique index `ai_workers_default_per_kind_uq`
 *     would refuse the flip.
 *
 * Slug generation: callers can pass an explicit slug or let
 * `createAiWorker` derive one from the name. The derived form is
 * `<kind>-<slugified-name>` (e.g. 'tts-saskia-natural') so the slug
 * carries the kind for at-a-glance debugging in logs.
 */

import { and, desc, eq } from 'drizzle-orm';
import {
  db,
  aiWorkers,
  type AiWorker,
  type AiWorkerKind,
  type AiWorkerParams,
  type NewAiWorker,
} from '@mantle/db';
import type { AiWorkerDTO } from '@mantle/client-types';

// Resolution helpers live in @mantle/db so apps/agent can use them
// without depending on apps/web. Re-exported here for convenience.
export { getDefaultWorker, bumpWorkerUsage } from '@mantle/db';

/**
 * Serialize a worker row to its API/wire shape (dates → ISO strings). The
 * explicit `AiWorkerDTO` return type makes this the drift checkpoint: if the
 * db row (or the `ai_worker_kind` enum) diverges from the client contract, this
 * mapping stops compiling. The `/api/ai-workers` routes return this.
 */
export function toAiWorkerDTO(w: AiWorker): AiWorkerDTO {
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    kind: w.kind,
    provider: w.provider,
    model: w.model,
    apiKeyId: w.apiKeyId,
    systemPrompt: w.systemPrompt,
    params: w.params as Record<string, unknown>,
    enabled: w.enabled,
    priority: w.priority,
    isDefault: w.isDefault,
    backupProvider: w.backupProvider,
    backupModel: w.backupModel,
    backupApiKeyId: w.backupApiKeyId,
    backupEnabled: w.backupEnabled,
    baseUrl: w.baseUrl,
    viaTailnet: w.viaTailnet,
    backupBaseUrl: w.backupBaseUrl,
    backupViaTailnet: w.backupViaTailnet,
    usageCount: w.usageCount,
    lastUsedAt: w.lastUsedAt ? w.lastUsedAt.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export type CreateAiWorkerInput = {
  ownerId: string;
  kind: AiWorkerKind;
  name: string;
  provider: string;
  model: string;
  apiKeyId?: string | null;
  systemPrompt?: string | null;
  params?: AiWorkerParams;
  enabled?: boolean;
  priority?: number;
  isDefault?: boolean;
  slug?: string;
  /** Optional BACKUP chat route (chat-shaped workers; migration 0062). A chat
   *  backup may be a different provider+model. */
  backupProvider?: string | null;
  backupModel?: string | null;
  backupApiKeyId?: string | null;
  backupEnabled?: boolean;
  /** Per-route host + tailnet flag (migration 0063). */
  baseUrl?: string | null;
  viaTailnet?: boolean;
  backupBaseUrl?: string | null;
  backupViaTailnet?: boolean;
};

/** Convert a free-form name into a slug-safe string. Lower-cased,
 *  hyphenated, alnum only, trimmed of leading/trailing hyphens. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 60);
}

/** Build a default slug that includes the kind, so logs are
 *  self-explanatory. Falls back to a uuid stem if the name is empty
 *  after slugification (e.g. all unicode). */
function defaultSlug(kind: AiWorkerKind, name: string): string {
  const tail = slugify(name) || crypto.randomUUID().slice(0, 8);
  return `${kind}-${tail}`;
}

export async function createAiWorker(input: CreateAiWorkerInput): Promise<AiWorker> {
  const row: NewAiWorker = {
    ownerId: input.ownerId,
    slug: input.slug ?? defaultSlug(input.kind, input.name),
    name: input.name.trim().slice(0, 120) || 'Unnamed worker',
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    apiKeyId: input.apiKeyId ?? null,
    systemPrompt: input.systemPrompt ?? null,
    params: (input.params ?? {}) as AiWorkerParams,
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    isDefault: false, // set via setDefaultWorker below if requested
    backupProvider: input.backupProvider ?? null,
    backupModel: input.backupModel ?? null,
    backupApiKeyId: input.backupApiKeyId ?? null,
    backupEnabled: input.backupEnabled ?? false,
    baseUrl: input.baseUrl ?? null,
    viaTailnet: input.viaTailnet ?? false,
    backupBaseUrl: input.backupBaseUrl ?? null,
    backupViaTailnet: input.backupViaTailnet ?? false,
  };
  return await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(aiWorkers).values(row).returning();
    if (!inserted) throw new Error('createAiWorker: insert returned no row');
    if (input.isDefault) {
      // Clear any existing default for this kind, then set this one.
      await tx
        .update(aiWorkers)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(aiWorkers.ownerId, inserted.ownerId),
            eq(aiWorkers.kind, inserted.kind),
            eq(aiWorkers.isDefault, true),
          ),
        );
      const [updated] = await tx
        .update(aiWorkers)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(aiWorkers.id, inserted.id))
        .returning();
      return updated ?? inserted;
    }
    return inserted;
  });
}

export type UpdateAiWorkerInput = Partial<
  Pick<
    AiWorker,
    | 'name'
    | 'provider'
    | 'model'
    | 'apiKeyId'
    | 'systemPrompt'
    | 'params'
    | 'enabled'
    | 'priority'
    | 'backupProvider'
    | 'backupModel'
    | 'backupApiKeyId'
    | 'backupEnabled'
    | 'baseUrl'
    | 'viaTailnet'
    | 'backupBaseUrl'
    | 'backupViaTailnet'
  >
>;

export async function updateAiWorker(
  ownerId: string,
  id: string,
  patch: UpdateAiWorkerInput,
): Promise<AiWorker | null> {
  const [row] = await db
    .update(aiWorkers)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(aiWorkers.id, id), eq(aiWorkers.ownerId, ownerId)))
    .returning();
  return row ?? null;
}

/** Atomic default swap. Clears the prior default for (ownerId, kind)
 *  before flipping the new one — otherwise the partial unique index
 *  refuses the update. Returns the updated row or null if the id is
 *  not found / not owned. */
export async function setDefaultWorker(
  ownerId: string,
  id: string,
): Promise<AiWorker | null> {
  return await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(aiWorkers)
      .where(and(eq(aiWorkers.id, id), eq(aiWorkers.ownerId, ownerId)))
      .limit(1);
    if (!target) return null;
    await tx
      .update(aiWorkers)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(aiWorkers.ownerId, ownerId),
          eq(aiWorkers.kind, target.kind),
          eq(aiWorkers.isDefault, true),
        ),
      );
    const [updated] = await tx
      .update(aiWorkers)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(aiWorkers.id, id))
      .returning();
    return updated ?? null;
  });
}

export async function deleteAiWorker(ownerId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(aiWorkers)
    .where(and(eq(aiWorkers.id, id), eq(aiWorkers.ownerId, ownerId)))
    .returning({ id: aiWorkers.id });
  return res.length > 0;
}

export async function getAiWorker(
  ownerId: string,
  id: string,
): Promise<AiWorker | null> {
  const [row] = await db
    .select()
    .from(aiWorkers)
    .where(and(eq(aiWorkers.id, id), eq(aiWorkers.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function listAiWorkers(ownerId: string): Promise<AiWorker[]> {
  return await db
    .select()
    .from(aiWorkers)
    .where(eq(aiWorkers.ownerId, ownerId))
    .orderBy(aiWorkers.kind, desc(aiWorkers.priority), desc(aiWorkers.updatedAt));
}

export async function listAiWorkersByKind(
  ownerId: string,
  kind: AiWorkerKind,
): Promise<AiWorker[]> {
  return await db
    .select()
    .from(aiWorkers)
    .where(and(eq(aiWorkers.ownerId, ownerId), eq(aiWorkers.kind, kind)))
    .orderBy(desc(aiWorkers.priority), desc(aiWorkers.updatedAt));
}

// getDefaultWorker / bumpWorkerUsage are re-exported from @mantle/db
// at the top of this file. The CRUD operations below are only used
// by the /settings/ai-workers UI in this app.
