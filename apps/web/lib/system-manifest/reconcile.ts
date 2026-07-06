/**
 * Boot-time manifest reconcile — closes the "updated the image but never ran the
 * seed scripts" gap for self-hosters.
 *
 * An update is `docker compose pull && up -d` (the in-app updater runs exactly
 * that — it does NOT refresh docker-compose.yml). That re-seeds builtins on boot
 * but does NOT seed new HTTP tools, new skills, updated tool-GROUP membership, or
 * grant new default groups to the responder — so a new capability silently never
 * reaches an existing brain (we hit this shipping 0.28.0: route_map/mapbox_directions
 * were added to the `location` group but the live group stayed stale).
 *
 * This runs from apps/web/instrumentation.ts on web-server boot (carried IN the
 * image, so a stale compose file can't skip it), and brings an already-provisioned
 * brain in line with the manifest, once per version:
 *   1. seedToolCapabilities(overwrite) — sync HTTP tools + tool-group MEMBERSHIP
 *      (gap-fill, the onboarding mode, deliberately won't touch an existing group).
 *   2. applyManifest(only:[], gap-fill, skillMode:overwrite) — force-sync the
 *      manifest-owned skill BODIES to the canonical text (so a shipped skill edit —
 *      e.g. the search_chunks retrieval policy in tool_grounding — actually reaches an
 *      existing brain on update, the same way tool-group membership does in step 1).
 *      `only:[]` still means NO specialist agents are created/overwritten (no OpenRouter
 *      key required) and the persona's own prompt is untouched; skillMode scopes the
 *      overwrite to MANIFEST_SKILLS, so operator-AUTHORED skills are never touched.
 *      In overwrite this also CONVERGES the persona's skill LINKS — detaching a
 *      manifest-owned skill the persona no longer carries (e.g. rich_writing after
 *      the chat_writing split). Operator-authored skill links are left attached.
 *   3. Reconcile the manifest persona's default capabilities onto enabled
 *      responders — BY ROLE, so an operator persona (Saskia/telegram-default) is
 *      reached, not just the `assistant` slug. Tool groups UNION (add-only); skill
 *      links CONVERGE (add new + drop a retired manifest skill like rich_writing;
 *      operator-authored skills kept). See reconcilePersonaCapabilitiesByRole.
 *   4. Provision any specialist agent that this version of the manifest ships but
 *      the brain is MISSING (e.g. `appsmith` in 0.31) — create-only, and wire the
 *      persona's delegation to it. This closes the same gap step 1 closes for
 *      tool groups, but for whole NEW specialists: a `docker compose pull && up`
 *      update never runs `seed:<agent>`, so without this a shipped specialist
 *      (and the persona's ability to delegate to it) silently never reaches an
 *      existing brain. gap-fill never overwrites an existing agent's
 *      prompt/model/params, and we key on EXISTENCE (not enabled), so a specialist
 *      the operator DISABLED is left alone — disable to opt out, don't delete.
 *      Needs the OpenRouter key a provisioned brain already has; if absent the
 *      whole reconcile is caught + retried on the next boot (self-healing).
 *
 * Safety: production-only, opt-out via MANTLE_DISABLE_BOOT_RECONCILE=1, skips a
 * fresh/unprovisioned brain (onboarding owns that), runs once per process and once
 * per APP_VERSION (a marker in profile prefs), and is fully best-effort — it can
 * NEVER throw into boot (a failure must not take the server down).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db, agents, skills, type AgentParams } from '@mantle/db';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import { APP_VERSION } from '@/lib/version';
import { applyManifest, seedToolCapabilities, seedManifestWorkers } from './seed';
import {
  MANIFEST_AGENTS,
  MANIFEST_SKILL_SLUGS,
  PERSONA_MANIFEST,
  PERSONA_TOOL_GROUP_SLUGS,
} from './manifest';
import { convergeManifestSkills, missingPersonaGroups } from './reconcile-util';

let ranThisProcess = false;

/** Single-owner system: prefer the configured id, else the sole auth.users row. */
async function resolveOwnerId(): Promise<string | null> {
  const fromEnv = process.env.ALLOWED_USER_ID?.trim();
  if (fromEnv) return fromEnv;
  const res = (await db.execute(sql`select id from auth.users limit 2`)) as unknown;
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
    id: string;
  }[];
  return rows.length === 1 ? (rows[0]!.id as string) : null;
}

/**
 * Reconcile the manifest persona's default CAPABILITIES onto every enabled
 * responder — the canonical `assistant` AND an operator persona (telegram-default
 * / Saskia), keyed by ROLE so a renamed responder is still reached. Tool groups
 * UNION (add-only); skill links CONVERGE — attach new manifest skills AND drop a
 * manifest-owned skill the persona no longer carries (e.g. `rich_writing` after
 * the chat_writing split), while operator-authored skills stay attached. The
 * by-ROLE reach (not just the `assistant` slug) is what lets a default-behaviour
 * change land on an operator-persona box WITHOUT a manual SQL detach. Returns the
 * `slug:+added -removed` strings changed.
 */
async function reconcilePersonaCapabilitiesByRole(ownerId: string): Promise<string[]> {
  const responders = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      groups: agents.toolGroupSlugs,
      skills: agents.skillSlugs,
    })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, ['responder', 'assistant']),
      ),
    );
  // Persona skills safe to ATTACH: manifest persona skills whose row exists + is
  // enabled. (The DROP side needs no existence check.)
  const wantSkills = PERSONA_MANIFEST.skillSlugs;
  const present = wantSkills.length
    ? await db
        .select({ slug: skills.slug })
        .from(skills)
        .where(
          and(eq(skills.ownerId, ownerId), eq(skills.enabled, true), inArray(skills.slug, wantSkills)),
        )
    : [];
  const addable = present.map((p) => p.slug);
  const changes: string[] = [];
  for (const a of responders) {
    const missingGroups = missingPersonaGroups(a.groups, PERSONA_TOOL_GROUP_SLUGS);
    const curSkills = a.skills ?? [];
    const nextSkills = convergeManifestSkills(curSkills, wantSkills, MANIFEST_SKILL_SLUGS, addable);
    const skillsChanged =
      nextSkills.length !== curSkills.length || nextSkills.some((s, i) => s !== curSkills[i]);
    if (missingGroups.length === 0 && !skillsChanged) continue;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (missingGroups.length) set.toolGroupSlugs = [...(a.groups ?? []), ...missingGroups];
    if (skillsChanged) set.skillSlugs = nextSkills;
    await db.update(agents).set(set).where(eq(agents.id, a.id));
    const added = [...missingGroups, ...nextSkills.filter((s) => !curSkills.includes(s))];
    const removed = curSkills.filter((s) => !nextSkills.includes(s));
    changes.push(
      `${a.slug}:${added.length ? `+${added.join(',')}` : ''}${removed.length ? ` -${removed.join(',')}` : ''}`,
    );
  }
  return changes;
}

/**
 * Reconcile each manifest specialist's product-owned capability links onto the
 * EXISTING specialist agent: UNION tool groups (additive — operator group adds
 * survive) and CONVERGE skills (add new manifest skills AND drop a manifest-owned
 * skill the specialist no longer carries in the manifest, while operator-authored
 * skills are untouched — mirrors syncPersonaSkills). Closes the gap where a NEW
 * group/skill added to an existing specialist (e.g. Appsmith gaining `research`)
 * — or a RETIRED default skill — never reaches an already-provisioned brain:
 * provisionMissingSpecialists only CREATES absent agents, and reconcile's
 * applyManifest runs with only:[] so it touches no existing specialist. Keyed on
 * enabled — a disabled specialist is an opt-out and is left alone. Returns the
 * `slug:+added -removed` strings changed.
 */
async function grantSpecialistCapabilities(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id, slug: agents.slug, groups: agents.toolGroupSlugs, skills: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.enabled, true)));
  const bySlug = new Map(rows.map((r) => [r.slug, r] as const));
  const changes: string[] = [];
  for (const a of MANIFEST_AGENTS) {
    if (a.isPersona) continue;
    const row = bySlug.get(a.slug);
    if (!row) continue; // absent (or disabled) → provisionMissingSpecialists owns it
    const missingGroups = missingPersonaGroups(row.groups, a.toolGroupSlugs ?? []);
    const curSkills = row.skills ?? [];
    const nextSkills = convergeManifestSkills(curSkills, a.skillSlugs, MANIFEST_SKILL_SLUGS);
    const skillsChanged =
      nextSkills.length !== curSkills.length || nextSkills.some((s, i) => s !== curSkills[i]);
    if (missingGroups.length === 0 && !skillsChanged) continue;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (missingGroups.length) set.toolGroupSlugs = [...(row.groups ?? []), ...missingGroups];
    if (skillsChanged) set.skillSlugs = nextSkills;
    await db.update(agents).set(set).where(eq(agents.id, row.id));
    const added = [...missingGroups, ...nextSkills.filter((s) => !curSkills.includes(s))];
    const removed = curSkills.filter((s) => !nextSkills.includes(s));
    changes.push(
      `${a.slug}:${added.length ? `+${added.join(',')}` : ''}${removed.length ? ` -${removed.join(',')}` : ''}`,
    );
  }
  return changes;
}

/**
 * Force-sync each EXISTING manifest specialist's PRODUCT-OWNED definition —
 * systemPrompt + model + params + memoryConfig — to the manifest, mirroring the
 * skill-body force-sync in step 2. A shipped specialist prompt FIX (e.g. the
 * Appsmith build→declare→call ordering that fixes invented tool slugs, v0.34.1)
 * lives in the AGENT prompt, which gap-fill deliberately never overwrites — so
 * without this it reaches only fresh installs, never an already-provisioned
 * brain. A specialist's prompt is product-owned the same way a manifest skill
 * body is; ditto its memoryConfig knobs (max_iterations / max_tool_calls /
 * history limits) — EXCEPT `delegate_to`, which the additive delegation grants
 * own (operator-added delegates must survive), so the live delegate_to is
 * always preserved verbatim. The PERSONA is never touched (its prompt is
 * operator-owned); tool groups, skills, and delegation are left to the additive
 * grants so operator ADDITIONS survive; a disabled specialist is skipped
 * (opt-out). Model honours the same per-agent env override the seed uses.
 * Returns the slugs whose def changed.
 */
async function syncSpecialistDefs(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      enabled: agents.enabled,
      systemPrompt: agents.systemPrompt,
      model: agents.model,
      params: agents.params,
      memoryConfig: agents.memoryConfig,
    })
    .from(agents)
    .where(eq(agents.ownerId, ownerId));
  const bySlug = new Map(rows.map((r) => [r.slug, r] as const));
  // memoryConfig comparison ignores delegate_to (grant-owned, preserved as-is).
  const mcForCompare = (mc: unknown): Record<string, unknown> => {
    const { delegate_to: _dt, ...rest } = ((mc ?? {}) as Record<string, unknown>);
    return Object.fromEntries(Object.entries(rest).sort(([x], [y]) => x.localeCompare(y)));
  };
  const synced: string[] = [];
  for (const a of MANIFEST_AGENTS) {
    if (a.isPersona || !a.systemPrompt) continue;
    const row = bySlug.get(a.slug);
    if (!row || !row.enabled) continue;
    const model = (a.envModelVar ? process.env[a.envModelVar] : undefined) || a.model;
    const promptChanged = (row.systemPrompt ?? '') !== a.systemPrompt;
    const modelChanged = row.model !== model;
    const paramsChanged = JSON.stringify(row.params ?? {}) !== JSON.stringify(a.params);
    const mcChanged =
      JSON.stringify(mcForCompare(row.memoryConfig)) !==
      JSON.stringify(mcForCompare(a.memoryConfig));
    if (!promptChanged && !modelChanged && !paramsChanged && !mcChanged) continue;
    const liveDelegateTo = ((row.memoryConfig ?? {}) as { delegate_to?: string[] }).delegate_to;
    await db
      .update(agents)
      .set({
        systemPrompt: a.systemPrompt,
        model,
        params: a.params as AgentParams,
        memoryConfig: {
          ...((a.memoryConfig ?? {}) as Record<string, unknown>),
          ...(liveDelegateTo !== undefined ? { delegate_to: liveDelegateTo } : {}),
        } as typeof agents.$inferSelect.memoryConfig,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, row.id));
    synced.push(a.slug);
  }
  return synced;
}

/**
 * Create any manifest specialist agent the brain is missing (a NEW specialist
 * shipped this version), and wire the persona's delegation to it. Keyed on
 * existence (not enabled) so an operator-disabled specialist is never recreated.
 * gap-fill: never overwrites an existing agent's prompt/model/params. Returns the
 * slugs created.
 */
async function provisionMissingSpecialists(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: agents.slug })
    .from(agents)
    .where(eq(agents.ownerId, ownerId));
  const have = new Set(rows.map((r) => r.slug));
  const missing = MANIFEST_AGENTS.filter((a) => !a.isPersona && !have.has(a.slug)).map((a) => a.slug);
  if (missing.length === 0) return [];
  // only:<missing> seeds just those agents (create) + wires delegation for the
  // ones that are isDelegate. Existing agents are untouched.
  await applyManifest(ownerId, { only: missing, mode: 'gap-fill' });
  return missing;
}

export async function reconcileManifestOnBoot(): Promise<void> {
  if (ranThisProcess) return;
  ranThisProcess = true;

  // Production update mechanism only — in dev you run `pnpm seed:*` by hand, and
  // dev may point at the prod DB (the tailnet workflow), which we must not mutate
  // on a `pnpm dev` boot.
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.MANTLE_DISABLE_BOOT_RECONCILE === '1') {
    console.log('[reconcile] disabled via MANTLE_DISABLE_BOOT_RECONCILE');
    return;
  }

  try {
    const ownerId = await resolveOwnerId();
    if (!ownerId) {
      console.log('[reconcile] no single owner — skipping (fresh/unprovisioned install)');
      return;
    }

    // Only reconcile an ALREADY-provisioned brain; onboarding seeds a fresh one.
    const [responder] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.ownerId, ownerId),
          eq(agents.enabled, true),
          inArray(agents.role, ['responder', 'assistant']),
        ),
      )
      .limit(1);
    if (!responder) {
      console.log('[reconcile] no provisioned responder — skipping (onboarding will seed)');
      return;
    }

    // Once per version: a normal restart on an already-synced brain is a no-op.
    const prefs = await loadProfilePreferences(ownerId);
    if (prefs.lastReconciledVersion === APP_VERSION) return;

    await seedToolCapabilities(ownerId, 'overwrite');
    await applyManifest(ownerId, { only: [], mode: 'gap-fill', skillMode: 'overwrite' });
    const personaChanges = await reconcilePersonaCapabilitiesByRole(ownerId);
    const provisioned = await provisionMissingSpecialists(ownerId);
    const specialistGrants = await grantSpecialistCapabilities(ownerId);
    const defsSynced = await syncSpecialistDefs(ownerId);
    // Create any MISSING required worker (a new always-on worker shipped this
    // version). Provision-only: an existing worker's model/provider is never
    // overwritten (operator cost choices stand); optional media workers are left
    // to onboarding.
    const { created: workersCreated } = await seedManifestWorkers(ownerId, { requiredOnly: true });
    await updateProfilePreferences(ownerId, { lastReconciledVersion: APP_VERSION });

    console.log(
      `[reconcile] synced manifest to v${APP_VERSION}` +
        (personaChanges.length ? `; persona ${personaChanges.join('; ')}` : ' (persona current)') +
        (provisioned.length ? `; provisioned ${provisioned.join(', ')}` : '') +
        (specialistGrants.length ? `; specialists ${specialistGrants.join('; ')}` : '') +
        (defsSynced.length ? `; defs synced ${defsSynced.join(', ')}` : '') +
        (workersCreated.length ? `; workers +${workersCreated.map((w) => w.kind).join(',')}` : ''),
    );
  } catch (err) {
    // Best-effort: a reconcile failure must never take the server down.
    console.error(
      '[reconcile] skipped (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}
