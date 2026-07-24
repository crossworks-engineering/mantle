/**
 * Agent Studio — the graph read model.
 *
 * `buildStudioGraph(ownerId)` assembles the whole agent/skill/worker graph into
 * `{ nodes, edges }` for the canvas, plus per-entity detail (incl. the
 * runtime-true composed prompt) for the inspector, plus the live
 * `checkSystemIntegrity` report for the health panel. One batched read; the
 * backbone every Studio phase renders from.
 *
 * Read-only. Owner-scoped. The composed-prompt preview runs the SAME
 * `resolveAgentSkills` + `composeSystemPromptWithSkills` a real turn uses
 * (apps/web/lib/assistant.ts), so what you see is what the model is sent —
 * minus the per-turn time/locale line, which is noted, not faked.
 *
 * See docs/agent-studio.md.
 */

import { db, tools, eq, and, type AgentMemoryConfig } from '@mantle/db';
import { resolveAgentSkills, composeSystemPromptWithSkills } from '@mantle/agent-runtime';
import { listAgents } from '@/lib/agents';
import { listSkills } from '@/lib/skills';
import { listToolGroups } from '@/lib/tool-groups';
import { listAiWorkers } from '@/lib/ai-workers';
import { checkSystemIntegrity, PERSONA_SLUG, MANIFEST_AGENTS } from '@/lib/system-manifest';
import type { SystemReport } from '@/lib/integrity/types';

// ── Canvas primitives ────────────────────────────────────────────────────────

export type StudioNodeKind = 'agent' | 'skill' | 'group';

export type StudioNode = {
  /** Stable canvas id, namespaced by kind: `agent:<slug>` / `skill:<slug>`. */
  id: string;
  kind: StudioNodeKind;
  slug: string;
  label: string;
  /** Secondary line — model for agents, tool-count for skills. */
  sublabel: string;
  enabled: boolean;
  isPersona: boolean;
  /** Node-local referential problems (dangling tool/skill/delegate, disabled). */
  issues: string[];
};

export type StudioEdge = {
  id: string;
  source: string;
  target: string;
  kind: 'skill' | 'delegate' | 'group';
};

// ── Inspector detail ─────────────────────────────────────────────────────────

export type ComposedSkillBlock = { slug: string; name: string; instructions: string };

export type StudioAgentDetail = {
  id: string;
  slug: string;
  name: string;
  model: string;
  role: string;
  enabled: boolean;
  isPersona: boolean;
  skillSlugs: string[];
  /** Skills attached but NOT resolved (missing or disabled) — surfaced honestly. */
  missingSkillSlugs: string[];
  delegateSlugs: string[];
  /** Tool groups granted to this agent. */
  toolGroupSlugs: string[];
  /** Granted groups that are missing or disabled — surfaced honestly. */
  missingToolGroupSlugs: string[];
  toolCount: number;
  params: { temperature?: number; max_tokens?: number };
  maxIterations?: number;
  /** Whether this is a manifest agent that can be reset to its canonical default. */
  resettable: boolean;
  /** The base system prompt (editable prose in Phase 2). */
  systemPrompt: string;
  /** The enabled, attached skills in composition order. */
  skillBlocks: ComposedSkillBlock[];
  /** The full assembled system prompt the model receives (base + skill blocks),
   *  exactly as `composeSystemPromptWithSkills` builds it on a real turn. */
  composedPrompt: string;
};

export type StudioSkillDetail = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  instructions: string;
  /** Fan-out: every agent that attaches this skill (the many-to-many). */
  usedByAgentSlugs: string[];
};

export type StudioToolGroupDetail = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  toolSlugs: string[];
  /** Fan-out: every agent that grants this group. */
  usedByAgentSlugs: string[];
};

export type StudioWorkerDetail = {
  id: string;
  kind: string;
  name: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  /** Worker prose (registry): the chat-worker system prompt + the vision/document
   *  extraction prompt, when present. */
  systemPrompt: string | null;
  extractionPrompt: string | null;
  issues: string[];
};

export type StudioGraph = {
  generatedAt: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
  agents: StudioAgentDetail[];
  skills: StudioSkillDetail[];
  toolGroups: StudioToolGroupDetail[];
  workers: StudioWorkerDetail[];
  /** Live config-integrity report (the same checker behind /debug/integrity). */
  report: SystemReport;
};

const agentNodeId = (slug: string) => `agent:${slug}`;
const skillNodeId = (slug: string) => `skill:${slug}`;
const groupNodeId = (slug: string) => `group:${slug}`;

/** Manifest agent slugs — only these can be reset to a canonical default. */
const MANIFEST_AGENT_SLUGS = new Set(MANIFEST_AGENTS.map((m) => m.slug));

function delegateTo(memoryConfig: AgentMemoryConfig | null | undefined): string[] {
  const dt = memoryConfig?.delegate_to;
  return Array.isArray(dt) ? (dt as string[]) : [];
}

export async function buildStudioGraph(ownerId: string): Promise<StudioGraph> {
  const [agents, skills, toolGroups, workers, toolRows, report] = await Promise.all([
    listAgents(ownerId),
    listSkills(ownerId),
    listToolGroups(ownerId),
    listAiWorkers(ownerId),
    db
      .select({ slug: tools.slug })
      .from(tools)
      .where(and(eq(tools.ownerId, ownerId), eq(tools.enabled, true))),
    checkSystemIntegrity(ownerId),
  ]);

  const enabledToolSlugs = new Set(toolRows.map((t) => t.slug));
  const enabledSkillSlugs = new Set(skills.filter((s) => s.enabled).map((s) => s.slug));
  const skillSlugs = new Set(skills.map((s) => s.slug));
  const toolGroupSlugs = new Set(toolGroups.map((g) => g.slug));
  const enabledToolGroupSlugs = new Set(toolGroups.filter((g) => g.enabled).map((g) => g.slug));
  const groupToolsBySlug = new Map(toolGroups.map((g) => [g.slug, g.toolSlugs] as const));
  /** P6: an agent's effective tool count = the tools its granted groups confer
   *  (tool groups are the sole grant mechanism). */
  const effectiveToolCount = (a: { toolGroupSlugs?: string[] | null }): number => {
    const set = new Set<string>();
    for (const g of a.toolGroupSlugs ?? [])
      for (const t of groupToolsBySlug.get(g) ?? []) set.add(t);
    return set.size;
  };
  const agentSlugs = new Set(agents.map((a) => a.slug));
  const enabledAgentSlugs = new Set(agents.filter((a) => a.enabled).map((a) => a.slug));

  const nodes: StudioNode[] = [];
  const edges: StudioEdge[] = [];

  // Agent nodes + agent→skill (uses) and agent→agent (delegates) edges.
  for (const a of agents) {
    const delegates = delegateTo(a.memoryConfig);
    const issues: string[] = [];
    if (!a.enabled) issues.push('agent disabled');
    const groupGrants = a.toolGroupSlugs ?? [];
    for (const s of a.skillSlugs)
      if (!enabledSkillSlugs.has(s)) issues.push(`skill '${s}' missing or disabled`);
    for (const g of groupGrants)
      if (!enabledToolGroupSlugs.has(g)) issues.push(`tool group '${g}' missing or disabled`);
    for (const d of delegates)
      if (!enabledAgentSlugs.has(d)) issues.push(`delegate '${d}' missing or disabled`);

    nodes.push({
      id: agentNodeId(a.slug),
      kind: 'agent',
      slug: a.slug,
      label: a.name,
      sublabel: a.model,
      enabled: a.enabled,
      isPersona: a.slug === PERSONA_SLUG,
      issues,
    });

    for (const s of a.skillSlugs) {
      if (skillSlugs.has(s)) {
        edges.push({
          id: `${agentNodeId(a.slug)}__skill:${s}`,
          source: agentNodeId(a.slug),
          target: skillNodeId(s),
          kind: 'skill',
        });
      }
    }
    for (const d of delegates) {
      if (agentSlugs.has(d)) {
        edges.push({
          id: `${agentNodeId(a.slug)}__deleg:${d}`,
          source: agentNodeId(a.slug),
          target: agentNodeId(d),
          kind: 'delegate',
        });
      }
    }
    for (const g of groupGrants) {
      if (toolGroupSlugs.has(g)) {
        edges.push({
          id: `${agentNodeId(a.slug)}__group:${g}`,
          source: agentNodeId(a.slug),
          target: groupNodeId(g),
          kind: 'group',
        });
      }
    }
  }

  // Skill nodes. Skills are pure teaching (P1) — sublabel reflects that, not a
  // tool count (which is always 0 now).
  for (const s of skills) {
    const issues: string[] = [];
    if (!s.enabled) issues.push('skill disabled');
    nodes.push({
      id: skillNodeId(s.slug),
      kind: 'skill',
      slug: s.slug,
      label: s.name,
      sublabel: 'teaching',
      enabled: s.enabled,
      isPersona: false,
      issues,
    });
  }

  // Tool group nodes (capability bundles). Sublabel = member-tool count; flag any
  // bundled tool that has no enabled row.
  for (const g of toolGroups) {
    const issues: string[] = [];
    if (!g.enabled) issues.push('group disabled');
    for (const t of g.toolSlugs)
      if (!enabledToolSlugs.has(t)) issues.push(`tool '${t}' has no enabled row`);
    nodes.push({
      id: groupNodeId(g.slug),
      kind: 'group',
      slug: g.slug,
      label: g.name,
      sublabel: `${g.toolSlugs.length} tool${g.toolSlugs.length === 1 ? '' : 's'}`,
      enabled: g.enabled,
      isPersona: false,
      issues,
    });
  }

  // Per-agent detail incl. the runtime-true composed prompt. Sequential — there
  // are only a handful of agents and each is one cached skill query.
  const agentDetails: StudioAgentDetail[] = [];
  for (const a of agents) {
    const attached = await resolveAgentSkills(ownerId, a.skillSlugs ?? []);
    const attachedSet = new Set(attached.map((s) => s.slug));
    agentDetails.push({
      id: a.id,
      slug: a.slug,
      name: a.name,
      model: a.model,
      role: a.role,
      enabled: a.enabled,
      isPersona: a.slug === PERSONA_SLUG,
      skillSlugs: a.skillSlugs ?? [],
      missingSkillSlugs: (a.skillSlugs ?? []).filter((s) => !attachedSet.has(s)),
      delegateSlugs: delegateTo(a.memoryConfig),
      toolGroupSlugs: a.toolGroupSlugs ?? [],
      missingToolGroupSlugs: (a.toolGroupSlugs ?? []).filter((g) => !enabledToolGroupSlugs.has(g)),
      toolCount: effectiveToolCount(a),
      params: { temperature: a.params?.temperature, max_tokens: a.params?.max_tokens },
      maxIterations: a.memoryConfig?.max_iterations,
      resettable: MANIFEST_AGENT_SLUGS.has(a.slug),
      systemPrompt: a.systemPrompt,
      skillBlocks: attached.map((s) => ({
        slug: s.slug,
        name: s.name,
        instructions: s.instructions,
      })),
      composedPrompt: composeSystemPromptWithSkills(a.systemPrompt, attached),
    });
  }

  const skillDetails: StudioSkillDetail[] = skills.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    enabled: s.enabled,
    instructions: s.instructions,
    usedByAgentSlugs: agents
      .filter((a) => (a.skillSlugs ?? []).includes(s.slug))
      .map((a) => a.slug),
  }));

  const toolGroupDetails: StudioToolGroupDetail[] = toolGroups.map((g) => ({
    id: g.id,
    slug: g.slug,
    name: g.name,
    enabled: g.enabled,
    toolSlugs: g.toolSlugs,
    usedByAgentSlugs: agents
      .filter((a) => (a.toolGroupSlugs ?? []).includes(g.slug))
      .map((a) => a.slug),
  }));

  const workerDetails: StudioWorkerDetail[] = workers.map((w) => {
    const params = (w.params ?? {}) as unknown as Record<string, unknown>;
    const extraction =
      typeof params.extraction_prompt === 'string' ? params.extraction_prompt : null;
    const issues: string[] = [];
    if (!w.enabled) issues.push('worker disabled');
    return {
      id: w.id,
      kind: w.kind,
      name: w.name,
      model: w.model,
      enabled: w.enabled,
      isDefault: w.isDefault,
      systemPrompt: w.systemPrompt ?? null,
      extractionPrompt: extraction,
      issues,
    };
  });

  return {
    generatedAt: report.generatedAt,
    nodes,
    edges,
    agents: agentDetails,
    skills: skillDetails,
    toolGroups: toolGroupDetails,
    workers: workerDetails,
    report,
  };
}
