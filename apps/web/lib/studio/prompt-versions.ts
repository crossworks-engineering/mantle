/**
 * Agent Studio Phase 2 — prose version history (docs/agent-studio.md).
 *
 * Append-only versioning for the human-editable prompt fields named in the prose
 * registry. Every edit + every revert inserts a `prompt_versions` row and writes
 * the new body to the live entity (agents / skills / ai_workers). v1 is the
 * original value, captured lazily the first time a field is edited, so no history
 * is lost. The version timeline IS the safety net — a live prompt is always one
 * revert away.
 *
 * Server-only. Every read/write is owner-scoped.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, agents, skills, aiWorkers, promptVersions, type PromptVersion } from '@mantle/db';
import { PROSE_REGISTRY, type ProseEntityType } from './registry';

export type { PromptVersion };

/** Validate the (entityType, field) pair is a known TEXT prose field. Throws on
 *  anything not in the registry (e.g. the structured persona_notes). */
function assertField(entityType: string, field: string): asserts entityType is ProseEntityType {
  const ok = PROSE_REGISTRY.some(
    (p) => p.entityType === entityType && p.field === field && p.shape === 'text',
  );
  if (!ok) throw new Error(`not a versionable prose field: ${entityType}.${field}`);
}

/** Read the current live value of a prose field, owner-scoped. Returns null when
 *  the entity doesn't exist / isn't owned; '' when the field is unset. */
export async function readLiveProse(
  ownerId: string,
  entityType: string,
  entityId: string,
  field: string,
): Promise<string | null> {
  assertField(entityType, field);
  if (entityType === 'agent' && field === 'system_prompt') {
    const [r] = await db
      .select({ v: agents.systemPrompt })
      .from(agents)
      .where(and(eq(agents.id, entityId), eq(agents.ownerId, ownerId)));
    return r ? r.v : null;
  }
  if (entityType === 'skill' && field === 'instructions') {
    const [r] = await db
      .select({ v: skills.instructions })
      .from(skills)
      .where(and(eq(skills.id, entityId), eq(skills.ownerId, ownerId)));
    return r ? r.v : null;
  }
  if (entityType === 'worker' && field === 'system_prompt') {
    const [r] = await db
      .select({ v: aiWorkers.systemPrompt })
      .from(aiWorkers)
      .where(and(eq(aiWorkers.id, entityId), eq(aiWorkers.ownerId, ownerId)));
    return r ? (r.v ?? '') : null;
  }
  if (entityType === 'worker' && field === 'extraction_prompt') {
    const [r] = await db
      .select({ p: aiWorkers.params })
      .from(aiWorkers)
      .where(and(eq(aiWorkers.id, entityId), eq(aiWorkers.ownerId, ownerId)));
    if (!r) return null;
    const p = (r.p ?? {}) as unknown as Record<string, unknown>;
    return typeof p.extraction_prompt === 'string' ? p.extraction_prompt : '';
  }
  return null;
}

/** Write the new body to the live entity, owner-scoped. */
async function writeLiveProse(
  ownerId: string,
  entityType: string,
  entityId: string,
  field: string,
  body: string,
): Promise<void> {
  const now = new Date();
  if (entityType === 'agent' && field === 'system_prompt') {
    await db
      .update(agents)
      .set({ systemPrompt: body, updatedAt: now })
      .where(and(eq(agents.id, entityId), eq(agents.ownerId, ownerId)));
    return;
  }
  if (entityType === 'skill' && field === 'instructions') {
    await db
      .update(skills)
      .set({ instructions: body, updatedAt: now })
      .where(and(eq(skills.id, entityId), eq(skills.ownerId, ownerId)));
    return;
  }
  if (entityType === 'worker' && field === 'system_prompt') {
    await db
      .update(aiWorkers)
      .set({ systemPrompt: body, updatedAt: now })
      .where(and(eq(aiWorkers.id, entityId), eq(aiWorkers.ownerId, ownerId)));
    return;
  }
  if (entityType === 'worker' && field === 'extraction_prompt') {
    // Merge into the params jsonb (preserve the other knobs).
    await db
      .update(aiWorkers)
      .set({
        params: sql`coalesce(${aiWorkers.params}, '{}'::jsonb) || ${JSON.stringify({ extraction_prompt: body })}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(aiWorkers.id, entityId), eq(aiWorkers.ownerId, ownerId)));
    return;
  }
  throw new Error(`no live writer for ${entityType}.${field}`);
}

/** Full version timeline for a prose field, newest first. */
export async function listProseVersions(
  ownerId: string,
  entityType: string,
  entityId: string,
  field: string,
): Promise<PromptVersion[]> {
  assertField(entityType, field);
  return db
    .select()
    .from(promptVersions)
    .where(
      and(
        eq(promptVersions.ownerId, ownerId),
        eq(promptVersions.entityType, entityType),
        eq(promptVersions.entityId, entityId),
        eq(promptVersions.field, field),
      ),
    )
    .orderBy(desc(promptVersions.version));
}

async function nextVersionRows(
  ownerId: string,
  entityType: string,
  entityId: string,
  field: string,
): Promise<PromptVersion[]> {
  return db
    .select()
    .from(promptVersions)
    .where(
      and(
        eq(promptVersions.ownerId, ownerId),
        eq(promptVersions.entityType, entityType),
        eq(promptVersions.entityId, entityId),
        eq(promptVersions.field, field),
      ),
    )
    .orderBy(asc(promptVersions.version));
}

async function insertVersion(args: {
  ownerId: string;
  entityType: string;
  entityId: string;
  field: string;
  version: number;
  body: string;
  note: string | null;
  author: string | null;
}): Promise<void> {
  await db.insert(promptVersions).values({
    ownerId: args.ownerId,
    entityType: args.entityType,
    entityId: args.entityId,
    field: args.field,
    version: args.version,
    body: args.body,
    note: args.note,
    author: args.author,
  });
}

/**
 * Save a new body for a prose field. Lazily seeds v1 from the current live value
 * the first time, then appends the edit as the next version and writes it live.
 * A no-op edit (unchanged body) doesn't add a version. Returns the timeline.
 */
export async function saveProse(args: {
  ownerId: string;
  entityType: string;
  entityId: string;
  field: string;
  body: string;
  note?: string | null;
  author?: string | null;
}): Promise<PromptVersion[]> {
  const { ownerId, entityType, entityId, field } = args;
  assertField(entityType, field);
  const newBody = args.body;
  const current = await readLiveProse(ownerId, entityType, entityId, field);
  if (current === null) throw new Error('entity not found or not owned');

  const existing = await nextVersionRows(ownerId, entityType, entityId, field);

  if (existing.length === 0) {
    // Seed the original as v1 so the pre-edit text is never lost.
    await insertVersion({
      ownerId,
      entityType,
      entityId,
      field,
      version: 1,
      body: current,
      note: '(original)',
      author: null,
    });
    if (current.trim() === newBody.trim()) {
      return listProseVersions(ownerId, entityType, entityId, field);
    }
    await insertVersion({
      ownerId,
      entityType,
      entityId,
      field,
      version: 2,
      body: newBody,
      note: args.note ?? null,
      author: args.author ?? null,
    });
    await writeLiveProse(ownerId, entityType, entityId, field, newBody);
    return listProseVersions(ownerId, entityType, entityId, field);
  }

  const latest = existing[existing.length - 1]!;
  if (latest.body.trim() === newBody.trim()) {
    // No real change — keep live in sync (in case it drifted) but add no version.
    await writeLiveProse(ownerId, entityType, entityId, field, newBody);
    return listProseVersions(ownerId, entityType, entityId, field);
  }
  await insertVersion({
    ownerId,
    entityType,
    entityId,
    field,
    version: latest.version + 1,
    body: newBody,
    note: args.note ?? null,
    author: args.author ?? null,
  });
  await writeLiveProse(ownerId, entityType, entityId, field, newBody);
  return listProseVersions(ownerId, entityType, entityId, field);
}

/**
 * Revert a field to an earlier version's body. Append-only: the revert becomes a
 * NEW version (so history is never rewritten). Returns the timeline.
 */
export async function revertProse(args: {
  ownerId: string;
  entityType: string;
  entityId: string;
  field: string;
  toVersion: number;
  author?: string | null;
}): Promise<PromptVersion[]> {
  const { ownerId, entityType, entityId, field, toVersion } = args;
  assertField(entityType, field);
  const versions = await listProseVersions(ownerId, entityType, entityId, field);
  const target = versions.find((v) => v.version === toVersion);
  if (!target) throw new Error(`version ${toVersion} not found`);
  return saveProse({
    ownerId,
    entityType,
    entityId,
    field,
    body: target.body,
    note: `revert to v${toVersion}`,
    author: args.author ?? null,
  });
}
