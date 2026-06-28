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
import {
  db,
  agents,
  skills,
  toolGroups,
  tools,
  apiKeys,
  type AgentMemoryConfig,
  type AgentParams,
  type AiWorkerKind,
} from '@mantle/db';
import { seedBuiltinTools, createTool, updateTool } from '@mantle/tools';
import { createAiWorker, updateAiWorker, listAiWorkers } from '@/lib/ai-workers';
import {
  MANIFEST_AGENTS,
  MANIFEST_HTTP_TOOLS,
  MANIFEST_SKILLS,
  MANIFEST_SKILL_SLUGS,
  MANIFEST_TOOL_GROUPS,
  MANIFEST_WORKERS,
  PERSONA_SLUG,
  PERSONA_TOOL_GROUP_SLUGS,
  DELEGATE_SLUGS,
  type ManifestAgent,
  type ManifestHttpTool,
  type ManifestSkill,
  type ManifestToolGroup,
} from './manifest';
import { convergeManifestSkills } from './reconcile-util';
import { resolveWorkerRoute } from './worker-route';
import { resolveEffectivePersona } from './persona';

export type ApplyMode = 'gap-fill' | 'overwrite';
export type ApplyManifestOpts = {
  /** Restrict to these AGENT slugs (CLI per-agent seeds). Omitted = all specialists. */
  only?: string[];
  /** Restrict to these SKILL slugs (CLI per-skill seeds). Omitted = all skills. */
  onlySkills?: string[];
  mode?: ApplyMode;
  /** Override the mode for SKILLS only. Lets the boot reconcile force-sync
   *  manifest-owned skill bodies ('overwrite') while leaving agents gap-filled
   *  (prompts/params/model untouched, no OpenRouter key required). Defaults to
   *  `mode`. Operator-authored skills (not in MANIFEST_SKILLS) are never seen
   *  by this loop, so they're never touched. */
  skillMode?: ApplyMode;
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

/** service → api_key id for this owner (prefers the 'default'-labelled key). */
async function keyIdByService(ownerId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: apiKeys.id, service: apiKeys.service, label: apiKeys.label })
    .from(apiKeys)
    .where(eq(apiKeys.userId, ownerId));
  const map: Record<string, string> = {};
  for (const k of rows) {
    if (!(k.service in map) || k.label === 'default') map[k.service] = k.id;
  }
  return map;
}

export type SeedWorkersResult = {
  created: { kind: string; name: string; provider: string; model: string }[];
  skipped: string[];
};

/**
 * Seed AI workers from MANIFEST_WORKERS — the single source for worker
 * models/params/routing, shared by onboarding and the boot reconcile. Idempotent:
 * a kind that already has a worker is left untouched (never re-models an existing
 * worker — operator cost choices stand). Picks each worker's route via
 * resolveWorkerRoute (voice upgrades to xAI when that key exists) and skips a
 * worker whose route has no key. `requiredOnly` (the reconcile path) seeds just
 * the always-on indexing workers, leaving optional media workers to onboarding.
 */
export async function seedManifestWorkers(
  ownerId: string,
  opts: { requiredOnly?: boolean } = {},
): Promise<SeedWorkersResult> {
  const [keys, existing] = await Promise.all([keyIdByService(ownerId), listAiWorkers(ownerId)]);
  const keyServices = new Set(Object.keys(keys));
  const haveKind = new Set(existing.map((w) => w.kind));
  const created: SeedWorkersResult['created'] = [];
  const skipped: string[] = [];
  for (const w of MANIFEST_WORKERS) {
    if (haveKind.has(w.kind)) continue;
    if (opts.requiredOnly && !w.required) continue;
    const route = resolveWorkerRoute(w, keyServices);
    if (!route) {
      skipped.push(`${w.kind} (no ${w.provider} key)`);
      continue;
    }
    await createAiWorker({
      ownerId,
      kind: w.kind,
      name: w.name,
      provider: route.provider,
      model: route.model,
      apiKeyId: keys[route.keyService]!,
      params: route.params,
      enabled: true,
      isDefault: true,
    });
    created.push({ kind: w.kind, name: w.name, provider: route.provider, model: route.model });
    haveKind.add(w.kind);
  }
  return { created, skipped };
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
    defaultState: {},
    enabled: true,
  });
}

/** Seed a tool group row. Capability-only bundle (docs/tools-and-skills.md).
 *  Like skills: gap-fill leaves an existing (operator-edited) group untouched;
 *  overwrite upserts to the canonical manifest membership. */
async function upsertToolGroup(ownerId: string, def: ManifestToolGroup, mode: ApplyMode): Promise<void> {
  const [existing] = await db
    .select({ id: toolGroups.id })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, def.slug)))
    .limit(1);
  if (existing) {
    if (mode === 'overwrite') {
      await db
        .update(toolGroups)
        .set({
          name: def.name,
          description: def.description,
          toolSlugs: def.toolSlugs,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(toolGroups.id, existing.id));
    }
    return;
  }
  await db.insert(toolGroups).values({
    ownerId,
    slug: def.slug,
    name: def.name,
    description: def.description,
    toolSlugs: def.toolSlugs,
    enabled: true,
  });
}

/** Seed a manifest HTTP tool (e.g. Mapbox geocoding). Like skills/groups:
 *  gap-fill leaves an existing tool untouched (operator may have edited it);
 *  overwrite re-syncs it to the manifest. Never clobbers a non-http tool that
 *  happens to share the slug (a human-authored shell tool, say). The tool sits
 *  dormant until the user adds the `{{secret:…}}` key it references. */
async function upsertHttpTool(ownerId: string, def: ManifestHttpTool, mode: ApplyMode): Promise<void> {
  const [existing] = await db
    .select({ id: tools.id, handler: tools.handler })
    .from(tools)
    .where(and(eq(tools.ownerId, ownerId), eq(tools.slug, def.slug)))
    .limit(1);
  if (existing) {
    if (mode === 'overwrite' && existing.handler?.kind === 'http') {
      await updateTool(ownerId, existing.id, {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        handler: def.handler,
        requiresConfirm: def.requiresConfirm ?? false,
        enabled: true,
      });
    }
    return;
  }
  await createTool(ownerId, {
    slug: def.slug,
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: def.handler,
    requiresConfirm: def.requiresConfirm ?? false,
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
  // P6: manifest agents are authored as pure tool GROUPS — the runtime effective
  // set is the union of the granted groups' tools. (The `agents.tool_slugs`
  // column was dropped in migration 0083.)
  const groupSlugs = def.toolGroupSlugs ?? [];
  const [existing] = await db
    .select({
      id: agents.id,
      skillSlugs: agents.skillSlugs,
      toolGroupSlugs: agents.toolGroupSlugs,
    })
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
      skillSlugs: def.skillSlugs,
      toolGroupSlugs: groupSlugs,
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
        skillSlugs: def.skillSlugs,
        toolGroupSlugs: groupSlugs,
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
  const mergedGroups = union(existing.toolGroupSlugs ?? [], groupSlugs);
  const set: Record<string, unknown> = { enabled: true, updatedAt: new Date() };
  if (mergedSkills.length !== (existing.skillSlugs ?? []).length) set.skillSlugs = mergedSkills;
  if (mergedGroups.length !== (existing.toolGroupSlugs ?? []).length) set.toolGroupSlugs = mergedGroups;
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

/**
 * Sync the persona's manifest skill links to the persona agent.
 *
 * - gap-fill (onboarding / per-agent CLI seeds): ADD-only — attach the persona's
 *   manifest skills, never remove (a stale-but-attached skill is left alone).
 * - overwrite (boot reconcile / operator "adopt from template"): CONVERGE — also
 *   DROP a manifest-owned skill the persona no longer carries in the manifest
 *   (e.g. `rich_writing` after the chat_writing split). Operator-authored skills
 *   (not in MANIFEST_SKILL_SLUGS) are never touched.
 *
 * Either way, only skills whose row exists + is enabled are attached.
 */
async function syncPersonaSkills(
  ownerId: string,
  skillMode: ApplyMode = 'gap-fill',
  targetSlug: string = PERSONA_SLUG,
): Promise<void> {
  const persona = MANIFEST_AGENTS.find((a) => a.isPersona);
  if (!persona) return;
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, targetSlug)))
    .limit(1);
  if (!row) return; // persona created by onboarding-provision; absent on operator brains
  // Only attach skills whose row exists + is enabled.
  const present = persona.skillSlugs.length
    ? await db
        .select({ slug: skills.slug })
        .from(skills)
        .where(
          and(eq(skills.ownerId, ownerId), eq(skills.enabled, true), inArray(skills.slug, persona.skillSlugs)),
        )
    : [];
  const addable = present.map((p) => p.slug);
  const next =
    skillMode === 'overwrite'
      ? convergeManifestSkills(row.skillSlugs, persona.skillSlugs, MANIFEST_SKILL_SLUGS, addable)
      : union(row.skillSlugs ?? [], addable);
  const current = row.skillSlugs ?? [];
  const changed = next.length !== current.length || next.some((s, i) => s !== current[i]);
  if (!changed) return;
  await db.update(agents).set({ skillSlugs: next, updatedAt: new Date() }).where(eq(agents.id, row.id));
}

/**
 * Seed the capability SUBSTRATE that agent tool-grants resolve against: the
 * builtin tool ROWS + the manifest tool GROUPS (P6: groups are the sole grant).
 * Idempotent. MUST run before any agent is granted those groups — onboarding
 * seeds this before the persona so a group grant never dangles (resolves to 0
 * tools) even if a later step fails. applyManifest runs it as its first step.
 */
export async function seedToolCapabilities(
  ownerId: string,
  mode: ApplyMode = 'gap-fill',
): Promise<void> {
  // Builtin tool rows must exist for the slugs the groups/agents reference.
  await seedBuiltinTools(ownerId);
  // Seeded HTTP tools (e.g. Mapbox geocoding) — referenced by tool groups too,
  // so they must exist before group upserts (a group bundling mapbox_* would
  // otherwise resolve short at runtime). Dormant until the user adds the key.
  for (const def of MANIFEST_HTTP_TOOLS) await upsertHttpTool(ownerId, def, mode);
  // Tool groups (capability bundles) — the unit every agent grants.
  for (const def of MANIFEST_TOOL_GROUPS) await upsertToolGroup(ownerId, def, mode);
}

export async function applyManifest(
  ownerId: string,
  opts: ApplyManifestOpts = {},
): Promise<ApplyManifestResult> {
  const mode: ApplyMode = opts.mode ?? 'gap-fill';

  // 1. Capability substrate: builtin tool rows + tool groups, before anything
  //    that grants them. See docs/tools-and-skills.md.
  await seedToolCapabilities(ownerId, mode);

  // 2. Skills (filtered by onlySkills). `skillMode` lets a caller force-sync
  //    manifest skill bodies (boot reconcile) without overwriting agents.
  const skillMode = opts.skillMode ?? mode;
  const skillDefs = opts.onlySkills
    ? MANIFEST_SKILLS.filter((s) => opts.onlySkills!.includes(s.slug))
    : MANIFEST_SKILLS;
  for (const def of skillDefs) await upsertSkill(ownerId, def, skillMode);

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

  // 5. The persona's shared behaviour skills — converge in overwrite (reconcile)
  //    so a default skill REMOVED from the persona (e.g. rich_writing) detaches;
  //    add-only in gap-fill (onboarding / CLI).
  await syncPersonaSkills(ownerId, skillMode);

  return { seededSkills: skillDefs.map((s) => s.slug), seededAgents };
}

// ─── per-item adopt (the /settings/config "Adopt from template" action) ──────
//
// Applies the manifest version of ONE item to the brain on demand — the same
// writes the boot reconcile makes on a version bump, but for a single item the
// operator picked. Semantics match reconcile exactly (see ./CLAUDE.md):
//   - skill / tool-group: overwrite the body / membership to the manifest.
//   - specialist agent: MERGE — overwrite prompt/model/params, UNION groups,
//     CONVERGE skills (add manifest skills + drop a retired one; operator skills
//     survive); a missing one is created + wired.
//   - persona: STRUCTURE only — union default groups + delegation, CONVERGE skills
//     (detaches a retired default like rich_writing); never the prompt/model/params.
//   - worker: create the missing one, or re-model an existing one to the route
//     (an explicit click MAY overwrite an operator-tuned model).

export type AdoptKind = 'persona' | 'agent' | 'skill' | 'tool-group' | 'worker';

/** MERGE a manifest specialist onto the brain: overwrite product-owned fields,
 *  union grants. Missing → create + wire delegation. Mirrors the boot reconcile
 *  (syncSpecialistDefs + grantSpecialistCapabilities) for one agent. */
async function adoptSpecialist(ownerId: string, def: ManifestAgent): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, skills: agents.skillSlugs, groups: agents.toolGroupSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, def.slug)))
    .limit(1);
  if (!row) {
    await applyManifest(ownerId, { only: [def.slug], mode: 'gap-fill' });
    return;
  }
  const model = (def.envModelVar ? process.env[def.envModelVar] : undefined) || def.model;
  await db
    .update(agents)
    .set({
      systemPrompt: def.systemPrompt ?? '',
      model,
      params: def.params as AgentParams,
      // Skills converge (drop a retired manifest skill); groups stay additive.
      skillSlugs: convergeManifestSkills(row.skills, def.skillSlugs, MANIFEST_SKILL_SLUGS),
      toolGroupSlugs: union(row.groups ?? [], def.toolGroupSlugs ?? []),
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, row.id));
  if (def.isDelegate) await wireDelegation(ownerId, [def.slug]);
}

/** Union the manifest persona's default tool groups + delegation onto the
 *  effective persona and attach its manifest skills. Never touches the
 *  operator-owned prompt/model/params. */
async function adoptPersonaStructure(ownerId: string): Promise<void> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      enabled: agents.enabled,
      role: agents.role,
      priority: agents.priority,
      groups: agents.toolGroupSlugs,
      memoryConfig: agents.memoryConfig,
    })
    .from(agents)
    .where(eq(agents.ownerId, ownerId));
  const persona = resolveEffectivePersona(
    rows.map((r) => ({ slug: r.slug, enabled: r.enabled, role: r.role, priority: r.priority })),
  );
  if (!persona) throw new Error('No persona agent to adopt onto.');
  const row = rows.find((r) => r.slug === persona.slug)!;
  const mc = (row.memoryConfig ?? {}) as AgentMemoryConfig & { delegate_to?: string[] };
  const current = Array.isArray(mc.delegate_to) ? mc.delegate_to : [];
  await db
    .update(agents)
    .set({
      toolGroupSlugs: union(row.groups ?? [], [...PERSONA_TOOL_GROUP_SLUGS]),
      memoryConfig: { ...mc, delegate_to: union(current, [...DELEGATE_SLUGS]) },
      updatedAt: new Date(),
    })
    .where(eq(agents.id, row.id));
  // Explicit operator "adopt" → converge (also detaches retired manifest skills).
  // Target the EFFECTIVE persona (an operator persona like Saskia, not necessarily
  // the `assistant` slug) so adopt actually clears what /settings/config flagged.
  await syncPersonaSkills(ownerId, 'overwrite', persona.slug);
}

/** Create the missing worker, or re-model an existing one to its manifest route. */
async function adoptWorker(ownerId: string, kind: AiWorkerKind): Promise<void> {
  const w = MANIFEST_WORKERS.find((x) => x.kind === kind);
  if (!w) throw new Error(`Unknown manifest worker '${kind}'.`);
  const keys = await keyIdByService(ownerId);
  const route = resolveWorkerRoute(w, new Set(Object.keys(keys)));
  if (!route) {
    throw new Error(
      `Can't adopt the '${kind}' worker — no API key for ${w.provider}. Add one at /settings/keys.`,
    );
  }
  const existing = (await listAiWorkers(ownerId)).find((x) => x.kind === kind);
  if (existing) {
    await updateAiWorker(ownerId, existing.id, {
      provider: route.provider,
      model: route.model,
      apiKeyId: keys[route.keyService]!,
      params: route.params,
    });
  } else {
    await createAiWorker({
      ownerId,
      kind: w.kind,
      name: w.name,
      provider: route.provider,
      model: route.model,
      apiKeyId: keys[route.keyService]!,
      params: route.params,
      enabled: true,
      isDefault: true,
    });
  }
}

/** Apply the manifest version of one config item to the brain (the /settings/config
 *  adopt action). Throws on an unknown slug or a worker with no key. */
export async function adoptManifestItem(
  ownerId: string,
  kind: AdoptKind,
  slug: string,
): Promise<void> {
  switch (kind) {
    case 'skill': {
      const def = MANIFEST_SKILLS.find((s) => s.slug === slug);
      if (!def) throw new Error(`Unknown manifest skill '${slug}'.`);
      await upsertSkill(ownerId, def, 'overwrite');
      return;
    }
    case 'tool-group': {
      const def = MANIFEST_TOOL_GROUPS.find((g) => g.slug === slug);
      if (!def) throw new Error(`Unknown manifest tool group '${slug}'.`);
      await upsertToolGroup(ownerId, def, 'overwrite');
      return;
    }
    case 'agent': {
      const def = MANIFEST_AGENTS.find((a) => a.slug === slug && !a.isPersona);
      if (!def) throw new Error(`Unknown manifest specialist '${slug}'.`);
      await adoptSpecialist(ownerId, def);
      return;
    }
    case 'persona':
      await adoptPersonaStructure(ownerId);
      return;
    case 'worker':
      await adoptWorker(ownerId, slug as AiWorkerKind);
      return;
  }
}
