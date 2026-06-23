/**
 * Config sanity checker — the pure diff engine.
 *
 * Field-level comparison of a brain's LIVE agent/skill/tool-group/worker config
 * against the declarative manifest (the shipped "template"). Where the integrity
 * checker (./integrity.ts) answers "does every reference resolve?" (referential
 * pass/fail), this answers "what DIFFERS from the template, per field?" — the
 * visibility layer behind /settings/config.
 *
 * Read-only and pure (no DB, no @/-aliased runtime imports) so it's unit-tested
 * directly, mirroring ./reconcile-util.ts and ./group-checks.ts. The DB-loading
 * wrapper lives in ./config-diff-db.ts.
 *
 * Persona handling (decided with the operator): the persona's prompt/model/params
 * are operator-owned and DELIBERATELY NOT diffed — only its structure (tool
 * groups, skills, delegation). Specialist prompts ARE surfaced, but as a
 * low-severity informational field. The result shape carries the manifest value
 * + kind + slug on every field so a later per-item "adopt" action can consume it
 * unchanged.
 */

import {
  MANIFEST_AGENTS,
  MANIFEST_SKILLS,
  MANIFEST_TOOL_GROUPS,
  MANIFEST_WORKERS,
  DELEGATE_SLUGS,
  type ManifestAgent,
  type ManifestSkill,
  type ManifestToolGroup,
  type ManifestWorker,
} from './manifest';
import { resolveEffectivePersona } from './persona';
// Type-only — erased at compile, so importing it doesn't pull @/ runtime code
// into the pure (vitest) module graph.
import type { AuditSeverity } from '@/lib/integrity/types';

// ─── result types ────────────────────────────────────────────────────────────

export type DiffStatus =
  /** Live matches the template (for tracked fields). */
  | 'ok'
  /** In the template, absent (or disabled) in the brain — a capability not landed. */
  | 'missing'
  /** In the brain, not in the template — operator-added, informational. */
  | 'extra'
  /** Present in both, but a tracked field diverges. */
  | 'modified';

export type EntityKind = 'persona' | 'agent' | 'skill' | 'tool-group' | 'worker';

export type FieldDiff = {
  /** 'toolGroupSlugs' | 'skillSlugs' | 'delegate_to' | 'instructions' |
   *  'toolSlugs' | 'model' | 'systemPrompt' | 'enabled' */
  field: string;
  /** The template value — what an "adopt" would write. */
  manifest: string | string[] | null;
  /** The live value in the brain. */
  live: string | string[] | null;
  /** Set fields only: members in `live` but not `manifest` (operator-added). */
  added?: string[];
  /** Set fields only: members in `manifest` but not `live` (not landed). */
  removed?: string[];
  /** Informational-only diff (e.g. a specialist prompt) — shown, not weighted. */
  info?: boolean;
};

export type EntityDiff = {
  kind: EntityKind;
  /** Agent/skill/group slug, or the worker kind. */
  slug: string;
  name: string;
  status: DiffStatus;
  severity: AuditSeverity;
  /** One-line human summary of the difference. */
  summary: string;
  /** Tracked fields that differ (empty when status is 'ok'). */
  fields: FieldDiff[];
  /** Can the operator "Adopt from template" this item? True for missing/modified
   *  (apply the manifest version); false for ok (nothing to do) and extra
   *  (operator-added — adopting would mean deleting, which we never do). */
  adoptable: boolean;
};

/** A diff before the (status-derived) `adoptable` flag is stamped on. */
export type EntityDiffCore = Omit<EntityDiff, 'adoptable'>;

export type ConfigDiffReport = {
  generatedAt: string;
  /** The shipped template version (APP_VERSION). */
  appVersion: string;
  /** The version the brain was last auto-reconciled to (null if never). */
  lastReconciledVersion: string | null;
  entities: EntityDiff[];
  counts: { ok: number; missing: number; extra: number; modified: number };
};

// ─── live input rows (decoupled from the DB schema for testability) ──────────

export type LiveAgentRow = {
  slug: string;
  name?: string | null;
  enabled: boolean;
  role: string;
  priority: number;
  skillSlugs?: string[] | null;
  toolGroupSlugs?: string[] | null;
  model?: string | null;
  systemPrompt?: string | null;
  /** agents.memory_config — we only read `delegate_to`. */
  memoryConfig?: unknown;
};

export type LiveSkillRow = {
  slug: string;
  name?: string | null;
  enabled: boolean;
  instructions: string;
};

export type LiveToolGroupRow = {
  slug: string;
  name?: string | null;
  enabled: boolean;
  toolSlugs?: string[] | null;
};

export type LiveWorkerRow = {
  kind: string;
  name?: string | null;
  enabled: boolean;
  isDefault?: boolean | null;
  model: string;
};

export type LiveConfig = {
  agents: LiveAgentRow[];
  skills: LiveSkillRow[];
  toolGroups: LiveToolGroupRow[];
  workers: LiveWorkerRow[];
};

/** Manifest slices — overridable in tests; default to the shipped exports. */
export type ManifestSlices = {
  agents: readonly ManifestAgent[];
  skills: readonly ManifestSkill[];
  toolGroups: readonly ManifestToolGroup[];
  workers: readonly ManifestWorker[];
  delegateSlugs: readonly string[];
};

const DEFAULT_MANIFEST: ManifestSlices = {
  agents: MANIFEST_AGENTS,
  skills: MANIFEST_SKILLS,
  toolGroups: MANIFEST_TOOL_GROUPS,
  workers: MANIFEST_WORKERS,
  delegateSlugs: DELEGATE_SLUGS,
};

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Two-way set difference: what live added vs the manifest, what it's missing. */
function setDiff(
  manifest: readonly string[] | null | undefined,
  live: readonly string[] | null | undefined,
): { added: string[]; removed: string[] } {
  const m = new Set(manifest ?? []);
  const l = new Set(live ?? []);
  return {
    added: [...l].filter((x) => !m.has(x)).sort(),
    removed: [...m].filter((x) => !l.has(x)).sort(),
  };
}

/** A set FieldDiff, or null when the sets match (nothing to report). */
function setField(
  field: string,
  manifest: readonly string[] | null | undefined,
  live: readonly string[] | null | undefined,
): FieldDiff | null {
  const { added, removed } = setDiff(manifest, live);
  if (added.length === 0 && removed.length === 0) return null;
  return {
    field,
    manifest: [...(manifest ?? [])].sort(),
    live: [...(live ?? [])].sort(),
    added,
    removed,
  };
}

/** Read `delegate_to` from an agent's memory_config (shape-tolerant). */
function delegateTo(memoryConfig: unknown): string[] {
  const dt = (memoryConfig as { delegate_to?: unknown } | null)?.delegate_to;
  return Array.isArray(dt) ? (dt as string[]) : [];
}

/** Highest severity wins when an entity has several field diffs. */
const SEVERITY_RANK: Record<AuditSeverity, number> = { low: 0, medium: 1, high: 2 };
function maxSeverity(a: AuditSeverity, b: AuditSeverity): AuditSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ─── per-kind diffing ────────────────────────────────────────────────────────

function diffPersona(live: LiveConfig, m: ManifestSlices): EntityDiffCore {
  const manifestPersona = m.agents.find((a) => a.isPersona);
  const personaSlug = manifestPersona?.slug ?? 'assistant';
  // Resolve the agent that ACTUALLY serves as the persona (slug-flexible).
  const livePersona = resolveEffectivePersona(
    live.agents.map((a) => ({ slug: a.slug, enabled: a.enabled, role: a.role, priority: a.priority })),
  );
  const liveRow = livePersona ? live.agents.find((a) => a.slug === livePersona.slug) ?? null : null;

  const base = { kind: 'persona' as const, slug: personaSlug, name: liveRow?.name || personaSlug };

  if (!liveRow || !liveRow.enabled) {
    return {
      ...base,
      status: 'missing',
      severity: 'high',
      summary: liveRow ? 'persona is disabled' : 'no persona agent found',
      fields: [],
    };
  }

  // Structure only — prompt/model/params are operator-owned and never diffed.
  const fields: FieldDiff[] = [];
  const groups = setField('toolGroupSlugs', manifestPersona?.toolGroupSlugs, liveRow.toolGroupSlugs);
  if (groups) fields.push(groups);
  const skills = setField('skillSlugs', manifestPersona?.skillSlugs, liveRow.skillSlugs);
  if (skills) fields.push(skills);
  // The persona should delegate to every shipped delegate specialist.
  const deleg = setField('delegate_to', m.delegateSlugs, delegateTo(liveRow.memoryConfig));
  if (deleg) fields.push(deleg);

  if (fields.length === 0) {
    return { ...base, status: 'ok', severity: 'low', summary: 'matches the template (structure)', fields };
  }
  return {
    ...base,
    status: 'modified',
    severity: 'medium',
    summary: summarizeFields(fields),
    fields,
  };
}

function diffSpecialist(a: ManifestAgent, live: LiveConfig, m: ManifestSlices): EntityDiffCore {
  const row = live.agents.find((r) => r.slug === a.slug);
  const base = { kind: 'agent' as const, slug: a.slug, name: row?.name || a.name };

  if (!row) {
    return { ...base, status: 'missing', severity: 'high', summary: 'not seeded', fields: [] };
  }
  if (!row.enabled) {
    return { ...base, status: 'missing', severity: 'high', summary: 'disabled', fields: [] };
  }

  const fields: FieldDiff[] = [];
  let severity: AuditSeverity = 'low';

  const groups = setField('toolGroupSlugs', a.toolGroupSlugs, row.toolGroupSlugs);
  if (groups) { fields.push(groups); severity = maxSeverity(severity, 'medium'); }
  const skills = setField('skillSlugs', a.skillSlugs, row.skillSlugs);
  if (skills) { fields.push(skills); severity = maxSeverity(severity, 'medium'); }
  const deleg = setField('delegate_to', a.memoryConfig?.delegate_to ?? [], delegateTo(row.memoryConfig));
  if (deleg) { fields.push(deleg); severity = maxSeverity(severity, 'medium'); }
  if (a.model && row.model && a.model !== row.model) {
    fields.push({ field: 'model', manifest: a.model, live: row.model });
    severity = maxSeverity(severity, 'medium');
  }
  // Specialist prompt: surfaced as informational only (not weighted).
  if (a.systemPrompt && (row.systemPrompt ?? '') !== a.systemPrompt) {
    fields.push({ field: 'systemPrompt', manifest: a.systemPrompt, live: row.systemPrompt ?? null, info: true });
  }

  if (fields.length === 0) {
    return { ...base, status: 'ok', severity: 'low', summary: 'matches the template', fields };
  }
  return { ...base, status: 'modified', severity, summary: summarizeFields(fields), fields };
}

function diffSkill(s: ManifestSkill, live: LiveConfig): EntityDiffCore {
  const row = live.skills.find((r) => r.slug === s.slug);
  const base = { kind: 'skill' as const, slug: s.slug, name: row?.name || s.name };
  if (!row || !row.enabled) {
    return { ...base, status: 'missing', severity: 'medium', summary: row ? 'disabled' : 'not seeded', fields: [] };
  }
  if (row.instructions !== s.instructions) {
    return {
      ...base,
      status: 'modified',
      severity: 'medium',
      summary: 'instructions differ from the template',
      fields: [{ field: 'instructions', manifest: s.instructions, live: row.instructions }],
    };
  }
  return { ...base, status: 'ok', severity: 'low', summary: 'matches the template', fields: [] };
}

function diffToolGroup(g: ManifestToolGroup, live: LiveConfig): EntityDiffCore {
  const row = live.toolGroups.find((r) => r.slug === g.slug);
  const base = { kind: 'tool-group' as const, slug: g.slug, name: row?.name || g.name };
  if (!row || !row.enabled) {
    return { ...base, status: 'missing', severity: 'medium', summary: row ? 'disabled' : 'not seeded', fields: [] };
  }
  const tools = setField('toolSlugs', g.toolSlugs, row.toolSlugs);
  if (tools) {
    return { ...base, status: 'modified', severity: 'medium', summary: summarizeFields([tools]), fields: [tools] };
  }
  return { ...base, status: 'ok', severity: 'low', summary: 'matches the template', fields: [] };
}

function diffWorker(w: ManifestWorker, live: LiveConfig): EntityDiffCore {
  // A kind is "present" when it has a default + enabled worker (what the runtime uses).
  const def = live.workers.find((r) => r.kind === w.kind && r.enabled && r.isDefault);
  const anyRow = live.workers.find((r) => r.kind === w.kind);
  const base = { kind: 'worker' as const, slug: w.kind, name: anyRow?.name || w.name };
  if (!def) {
    return {
      ...base,
      status: 'missing',
      // A required worker missing is a real problem; optional just isn't provisioned.
      severity: w.required ? 'high' : 'low',
      summary: w.required ? 'no default+enabled worker (indexing degraded)' : 'not provisioned (optional)',
      fields: [],
    };
  }
  // A worker on its declared alt route (voice → xAI) is not drift — accept the
  // default model OR the alt model.
  const modelOk = def.model === w.model || (w.altModel != null && def.model === w.altModel);
  if (!modelOk) {
    return {
      ...base,
      status: 'modified',
      severity: 'low',
      summary: 'model differs from the template',
      fields: [{ field: 'model', manifest: w.model, live: def.model }],
    };
  }
  return { ...base, status: 'ok', severity: 'low', summary: 'matches the template', fields: [] };
}

/** Operator-added entities with no manifest counterpart — informational. */
function diffExtras(live: LiveConfig, m: ManifestSlices): EntityDiffCore[] {
  const out: EntityDiffCore[] = [];
  const manifestAgentSlugs = new Set(m.agents.map((a) => a.slug));
  const personaSlug = m.agents.find((a) => a.isPersona)?.slug ?? 'assistant';
  const livePersona = resolveEffectivePersona(
    live.agents.map((a) => ({ slug: a.slug, enabled: a.enabled, role: a.role, priority: a.priority })),
  );
  for (const a of live.agents) {
    // Skip manifest agents and whichever agent serves as the effective persona.
    if (manifestAgentSlugs.has(a.slug) || a.slug === personaSlug || a.slug === livePersona?.slug) continue;
    out.push({
      kind: 'agent', slug: a.slug, name: a.name || a.slug,
      status: 'extra', severity: 'low', summary: 'operator-added (not in template)', fields: [],
    });
  }
  const manifestSkillSlugs = new Set(m.skills.map((s) => s.slug));
  for (const s of live.skills) {
    if (manifestSkillSlugs.has(s.slug)) continue;
    out.push({
      kind: 'skill', slug: s.slug, name: s.name || s.slug,
      status: 'extra', severity: 'low', summary: 'operator-added (not in template)', fields: [],
    });
  }
  const manifestGroupSlugs = new Set(m.toolGroups.map((g) => g.slug));
  for (const g of live.toolGroups) {
    if (manifestGroupSlugs.has(g.slug)) continue;
    out.push({
      kind: 'tool-group', slug: g.slug, name: g.name || g.slug,
      status: 'extra', severity: 'low', summary: 'operator-added (not in template)', fields: [],
    });
  }
  return out;
}

function summarizeFields(fields: FieldDiff[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (f.info) continue;
    if (f.added?.length || f.removed?.length) {
      const bits: string[] = [];
      if (f.removed?.length) bits.push(`missing ${f.removed.length}`);
      if (f.added?.length) bits.push(`added ${f.added.length}`);
      parts.push(`${f.field} (${bits.join(', ')})`);
    } else {
      parts.push(`${f.field} differs`);
    }
  }
  if (parts.length === 0) parts.push('prompt differs');
  return parts.join(' · ');
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Diff a brain's live config against the manifest template. Pure — pass the live
 * rows in; the manifest defaults to the shipped exports (overridable in tests).
 * Order: persona, specialists, skills, tool groups, workers, then extras.
 */
export function diffConfig(
  live: LiveConfig,
  manifest: ManifestSlices = DEFAULT_MANIFEST,
): EntityDiff[] {
  const entities: EntityDiffCore[] = [];
  entities.push(diffPersona(live, manifest));
  for (const a of manifest.agents) {
    if (a.isPersona) continue;
    entities.push(diffSpecialist(a, live, manifest));
  }
  for (const s of manifest.skills) entities.push(diffSkill(s, live));
  for (const g of manifest.toolGroups) entities.push(diffToolGroup(g, live));
  for (const w of manifest.workers) entities.push(diffWorker(w, live));
  entities.push(...diffExtras(live, manifest));
  // Stamp the (status-derived) adopt affordance: apply the manifest version of a
  // missing/modified item; ok = nothing to do, extra = operator-added (never deleted).
  return entities.map((e) => ({
    ...e,
    adoptable: e.status === 'missing' || e.status === 'modified',
  }));
}

/** Tally entity statuses for the report header. */
export function countStatuses(entities: EntityDiff[]): ConfigDiffReport['counts'] {
  const counts = { ok: 0, missing: 0, extra: 0, modified: 0 };
  for (const e of entities) counts[e.status] += 1;
  return counts;
}
