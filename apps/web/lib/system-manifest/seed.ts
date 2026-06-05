/**
 * Manifest-driven seeder — the single seeding path for the default system.
 *
 * `applyManifest(ownerId, opts)` idempotently brings the DB in line with the
 * manifest: builtin tool rows → skills → specialist agents → delegation wiring
 * → the persona's skill attach. It REPLACES the per-script wiring
 * (seedSpecialistStack + linkAssistantSkills + each seed's grant function), and
 * the CLI `pnpm seed:*` scripts are now thin wrappers over it.
 *
 * Two modes:
 *   - 'gap-fill' (default, onboarding): create what's absent; for an EXISTING
 *     agent never overwrite its prompt/model/params (operator customisations) —
 *     only union skillSlugs, set toolSlugs if empty, and ensure enabled. Existing
 *     skills are left untouched. Re-running the wizard can't clobber edits.
 *   - 'overwrite' (CLI seed:*): upsert rows to the canonical manifest definition.
 *
 * The persona agent itself is NOT created here (onboarding-provision creates it
 * with the persona-bank prompt + the chosen voice/key); applyManifest only
 * attaches the persona's manifest skills + wires delegation to it.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, agents, skills, apiKeys, type AgentMemoryConfig, type AgentParams } from '@mantle/db';
import { seedBuiltinTools } from '@mantle/tools';
import {
  MANIFEST_AGENTS,
  MANIFEST_SKILLS,
  PERSONA_SLUG,
  resolveManifestToolSlugs,
  type ManifestAgent,
  type ManifestSkill,
} from './manifest';

export type ApplyMode = 'gap-fill' | 'overwrite';
export type ApplyManifestOpts = {
  /** Restrict to these AGENT slugs (CLI per-agent seeds). Omitted = all specialists. */
  only?: string[];
  /** Restrict to these SKILL slugs (CLI per-skill seeds). Omitted = all skills. */
  onlySkills?: string[];
  mode?: ApplyMode;
};
export type ApplyManifestResult = { seededSkills: string[]; seededAgents: string[] };

async function resolveOpenRouterKeyId(ownerId: string): Promise<string> {
  const rows = await db
    .select({ id: apiKeys.id, label: apiKeys.label })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, ownerId), eq(apiKeys.service, 'openrouter')));
  if (rows.length === 0) {
    throw new Error("No 'openrouter' API key found. Add one at /settings/keys first.");
  }
  return (rows.find((r) => r.label === 'default') ?? rows[0]!).id;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

async function upsertSkill(ownerId: string, def: ManifestSkill, mode: ApplyMode): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.ownerId, ownerId), eq(skills.slug, def.slug)))
    .limit(1);
  if (existing) {
    // gap-fill leaves an existing (possibly operator-edited) skill untouched.
    if (mode === 'overwrite') {
      await db
        .update(skills)
        .set({
          name: def.name,
          description: def.description,
          instructions: def.instructions,
          toolSlugs: def.toolSlugs,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, existing.id));
    }
    return;
  }
  await db.insert(skills).values({
    ownerId,
    slug: def.slug,
    name: def.name,
    description: def.description,
    instructions: def.instructions,
    toolSlugs: def.toolSlugs,
    defaultState: {},
    enabled: true,
  });
}

async function upsertAgent(
  ownerId: string,
  def: ManifestAgent,
  apiKeyId: string,
  mode: ApplyMode,
): Promise<void> {
  const model = (def.envModelVar ? process.env[def.envModelVar] : undefined) || def.model;
  const toolSlugs = resolveManifestToolSlugs(def);
  const [existing] = await db
    .select({ id: agents.id, toolSlugs: agents.toolSlugs, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, def.slug)))
    .limit(1);

  if (!existing) {
    await db.insert(agents).values({
      ownerId,
      slug: def.slug,
      name: def.name,
      description: def.description,
      role: def.role,
      provider: 'openrouter',
      model,
      apiKeyId,
      systemPrompt: def.systemPrompt ?? '',
      toolSlugs,
      skillSlugs: def.skillSlugs,
      params: def.params as AgentParams,
      memoryConfig: (def.memoryConfig ?? {}) as AgentMemoryConfig,
      priority: def.priority,
      enabled: true,
    });
    return;
  }

  if (mode === 'overwrite') {
    await db
      .update(agents)
      .set({
        name: def.name,
        description: def.description,
        role: def.role,
        model,
        apiKeyId,
        systemPrompt: def.systemPrompt ?? '',
        toolSlugs,
        skillSlugs: def.skillSlugs,
        params: def.params as AgentParams,
        memoryConfig: (def.memoryConfig ?? {}) as AgentMemoryConfig,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, existing.id));
    return;
  }

  // gap-fill: additive only — never touch prompt/model/params.
  const mergedSkills = union(existing.skillSlugs ?? [], def.skillSlugs);
  const set: Record<string, unknown> = { enabled: true, updatedAt: new Date() };
  if (mergedSkills.length !== (existing.skillSlugs ?? []).length) set.skillSlugs = mergedSkills;
  if (!(existing.toolSlugs ?? []).length) set.toolSlugs = toolSlugs;
  await db.update(agents).set(set).where(eq(agents.id, existing.id));
}

/**
 * Wire each in-scope delegate specialist into the delegate_to of every enabled
 * entry-point agent (responder/assistant) — additive, slug-agnostic (so it
 * works whether the persona is the manifest 'assistant' or an operator persona
 * like 'telegram-default'). Only adds when missing.
 */
async function wireDelegation(ownerId: string, delegateSlugs: string[]): Promise<void> {
  if (delegateSlugs.length === 0) return;
  const entryRows = await db
    .select({ id: agents.id, role: agents.role, memoryConfig: agents.memoryConfig })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.enabled, true)));
  const entries = entryRows.filter((r) => r.role === 'responder' || r.role === 'assistant');
  for (const entry of entries) {
    const mc = (entry.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
    const current = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
    const merged = union(current, delegateSlugs);
    if (merged.length === current.length) continue;
    await db
      .update(agents)
      .set({ memoryConfig: { ...mc, delegate_to: merged }, updatedAt: new Date() })
      .where(eq(agents.id, entry.id));
  }
}

/** Attach the persona's manifest skills to the persona agent (additive). */
async function attachPersonaSkills(ownerId: string): Promise<void> {
  const persona = MANIFEST_AGENTS.find((a) => a.isPersona);
  if (!persona || persona.skillSlugs.length === 0) return;
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, PERSONA_SLUG)))
    .limit(1);
  if (!row) return; // persona created by onboarding-provision; absent on operator brains
  // Only attach skills whose row exists + is enabled.
  const present = await db
    .select({ slug: skills.slug })
    .from(skills)
    .where(
      and(eq(skills.ownerId, ownerId), eq(skills.enabled, true), inArray(skills.slug, persona.skillSlugs)),
    );
  const merged = union(row.skillSlugs ?? [], present.map((p) => p.slug));
  if (merged.length === (row.skillSlugs ?? []).length) return;
  await db.update(agents).set({ skillSlugs: merged, updatedAt: new Date() }).where(eq(agents.id, row.id));
}

export async function applyManifest(
  ownerId: string,
  opts: ApplyManifestOpts = {},
): Promise<ApplyManifestResult> {
  const mode: ApplyMode = opts.mode ?? 'gap-fill';

  // 1. Builtin tool rows must exist for the slugs the skills/agents reference.
  await seedBuiltinTools(ownerId);

  // 2. Skills (filtered by onlySkills).
  const skillDefs = opts.onlySkills
    ? MANIFEST_SKILLS.filter((s) => opts.onlySkills!.includes(s.slug))
    : MANIFEST_SKILLS;
  for (const def of skillDefs) await upsertSkill(ownerId, def, mode);

  // 3. Specialist agents (filtered by `only`; the persona is created elsewhere).
  const agentDefs = MANIFEST_AGENTS.filter(
    (a) => !a.isPersona && (!opts.only || opts.only.includes(a.slug)),
  );
  const seededAgents: string[] = [];
  if (agentDefs.length > 0) {
    const apiKeyId = await resolveOpenRouterKeyId(ownerId);
    for (const def of agentDefs) {
      await upsertAgent(ownerId, def, apiKeyId, mode);
      seededAgents.push(def.name);
    }
  }

  // 4. Delegation wiring for the in-scope delegate specialists.
  await wireDelegation(
    ownerId,
    agentDefs.filter((a) => a.isDelegate).map((a) => a.slug),
  );

  // 5. The persona's shared behaviour skills.
  await attachPersonaSkills(ownerId);

  return { seededSkills: skillDefs.map((s) => s.slug), seededAgents };
}
