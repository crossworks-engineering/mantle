/**
 * Live config-integrity checker — diffs the real agent/skill/tool/worker rows
 * against the manifest and validates referential integrity, catching the
 * silent-drop cases the runtime resolvers hide (resolveAgentSkills /
 * resolveAgentTools just omit a missing/disabled link with no error).
 *
 * Read-only. Surfaced in /debug/integrity (System tab) and reused by the
 * onboarding Check step. Returns severity-tagged findings (same vocabulary as
 * the corpus audit) — green when every vital link resolves.
 */

import { db, agents, skills, toolGroups, tools, eq, and, type AgentMemoryConfig } from '@mantle/db';
import { listAiWorkers } from '@/lib/ai-workers';
import { resolveAssistAgentSlug } from '@/lib/assist-agent';
import type { SystemCheck, SystemReport, SystemSample } from '@/lib/integrity/types';
import {
  MANIFEST_AGENTS,
  MANIFEST_TOOL_GROUPS,
  MANIFEST_WORKERS,
  DELEGATE_SLUGS,
  PERSONA_SLUG,
} from './manifest';
import { resolveEffectivePersona } from './persona';

function delegateTo(memoryConfig: unknown): string[] {
  const dt = (memoryConfig as AgentMemoryConfig | null)?.delegate_to;
  return Array.isArray(dt) ? (dt as string[]) : [];
}

export async function checkSystemIntegrity(ownerId: string): Promise<SystemReport> {
  const [agentRows, skillRows, toolGroupRows, toolRows, workers] = await Promise.all([
    db
      .select({
        slug: agents.slug,
        enabled: agents.enabled,
        role: agents.role,
        priority: agents.priority,
        toolSlugs: agents.toolSlugs,
        skillSlugs: agents.skillSlugs,
        toolGroupSlugs: agents.toolGroupSlugs,
        memoryConfig: agents.memoryConfig,
      })
      .from(agents)
      .where(eq(agents.ownerId, ownerId)),
    db
      .select({ slug: skills.slug, enabled: skills.enabled })
      .from(skills)
      .where(eq(skills.ownerId, ownerId)),
    db
      .select({ slug: toolGroups.slug, enabled: toolGroups.enabled, toolSlugs: toolGroups.toolSlugs })
      .from(toolGroups)
      .where(eq(toolGroups.ownerId, ownerId)),
    db
      .select({ slug: tools.slug })
      .from(tools)
      .where(and(eq(tools.ownerId, ownerId), eq(tools.enabled, true))),
    listAiWorkers(ownerId),
  ]);

  const agentBySlug = new Map(agentRows.map((a) => [a.slug, a] as const));
  const enabledToolSlugs = new Set(toolRows.map((t) => t.slug));
  const enabledSkillSlugs = new Set(skillRows.filter((s) => s.enabled).map((s) => s.slug));
  const enabledToolGroupSlugs = new Set(toolGroupRows.filter((g) => g.enabled).map((g) => g.slug));
  const toolGroupBySlug = new Map(toolGroupRows.map((g) => [g.slug, g] as const));

  /** P6: an agent's effective tool set = direct tool_slugs (vestigial, dropped
   *  in P6b) ∪ the tools conferred by its ENABLED granted groups. */
  const effectiveAgentTools = (a: {
    toolSlugs?: string[] | null;
    toolGroupSlugs?: string[] | null;
  }): Set<string> => {
    const set = new Set<string>(a.toolSlugs ?? []);
    for (const g of a.toolGroupSlugs ?? []) {
      const grp = toolGroupBySlug.get(g);
      if (grp?.enabled) for (const t of grp.toolSlugs ?? []) set.add(t);
    }
    return set;
  };

  const checks: SystemCheck[] = [];

  // 1. Persona — exists, enabled, can act, can delegate, carries grounding skills.
  //    Slug-flexible: anchor on the canonical slug `assistant`, but on a brain
  //    hand-built before onboarding (persona = an operator slug like
  //    telegram-default/Saskia) fall back to the real responder so it's measured
  //    against the persona it actually has. See ./persona.ts.
  const persona = resolveEffectivePersona(agentRows);
  const personaSlug = persona?.slug ?? PERSONA_SLUG;
  {
    const samples: SystemSample[] = [];
    let ok = true;
    if (!persona || !persona.enabled) {
      ok = false;
      samples.push({ id: personaSlug, detail: persona ? 'disabled' : 'no persona agent (no slug `assistant`, no enabled responder)' });
    } else {
      const eff = effectiveAgentTools(persona);
      if (eff.size === 0) {
        ok = false;
        samples.push({ id: personaSlug, detail: 'no tools attached (no groups granted) — cannot act' });
      } else if (!eff.has('invoke_agent')) {
        ok = false;
        samples.push({ id: personaSlug, detail: 'missing invoke_agent — cannot delegate' });
      }
      const skillSet = new Set(persona.skillSlugs ?? []);
      for (const s of ['tool_grounding', 'voice_reply']) {
        if (!skillSet.has(s)) {
          ok = false;
          samples.push({ id: s, detail: 'behaviour skill not attached to the persona' });
        }
      }
    }
    checks.push({
      key: 'persona',
      label: `Persona agent (${personaSlug})`,
      severity: 'high',
      ok,
      detail: ok
        ? `${effectiveAgentTools(persona!).size} tools · can delegate · grounded`
        : 'the persona is missing or can’t act — fix before relying on the assistant',
      samples,
    });
  }

  // 2. Specialist agents present + enabled.
  {
    const samples: SystemSample[] = [];
    for (const a of MANIFEST_AGENTS) {
      if (a.isPersona) continue;
      const row = agentBySlug.get(a.slug);
      if (!row || !row.enabled) {
        samples.push({ id: a.slug, detail: row ? 'disabled' : 'not seeded' });
      }
    }
    checks.push({
      key: 'specialists',
      label: 'Specialist agents',
      severity: 'high',
      ok: samples.length === 0,
      detail:
        samples.length === 0
          ? `${MANIFEST_AGENTS.length - 1} specialists seeded + enabled`
          : `${samples.length} missing/disabled — delegation + editor Assist degrade`,
      samples,
    });
  }

  // 3. Delegation wiring — persona delegates to every specialist that exists.
  {
    const dt = new Set(persona ? delegateTo(persona.memoryConfig) : []);
    const samples: SystemSample[] = [];
    for (const slug of DELEGATE_SLUGS) {
      const exists = agentBySlug.get(slug)?.enabled;
      if (exists && !dt.has(slug)) {
        samples.push({ id: slug, detail: 'agent exists but is not in the persona’s delegate_to' });
      }
    }
    checks.push({
      key: 'delegation',
      label: 'Delegation wiring',
      severity: 'medium',
      ok: samples.length === 0,
      detail:
        samples.length === 0
          ? 'the persona delegates to every available specialist'
          : `${samples.length} specialist(s) not wired into delegate_to`,
      samples,
    });
  }

  // 4. Specialist skills — each manifest agent carries its manifest skillSlugs.
  {
    const samples: SystemSample[] = [];
    for (const a of MANIFEST_AGENTS) {
      const row = agentBySlug.get(a.slug);
      if (!row) continue;
      const have = new Set(row.skillSlugs ?? []);
      for (const s of a.skillSlugs) {
        if (!have.has(s)) samples.push({ id: `${a.slug}:${s}`, detail: `${a.slug} is missing skill '${s}'` });
      }
    }
    checks.push({
      key: 'agent-skills',
      label: 'Agent ↔ skill links',
      severity: 'medium',
      ok: samples.length === 0,
      detail: samples.length === 0 ? 'every agent carries its expected skills' : `${samples.length} expected skill link(s) missing`,
      samples,
    });
  }

  // 5. Dangling tool links — ANY agent (incl. operator personas) referencing a
  //    tool slug with no enabled row. Silent at runtime; surfaced here.
  {
    const samples: SystemSample[] = [];
    for (const a of agentRows) {
      for (const t of a.toolSlugs ?? []) {
        if (!enabledToolSlugs.has(t)) samples.push({ id: `${a.slug}:${t}`, detail: `${a.slug} → tool '${t}' has no enabled row` });
      }
    }
    checks.push({
      key: 'dangling-tools',
      label: 'Dangling tool references',
      severity: 'high',
      ok: samples.length === 0,
      detail: samples.length === 0 ? 'every agent tool slug resolves to an enabled tool' : `${samples.length} dangling tool ref(s) — the agent silently can’t call them`,
      samples: samples.slice(0, 25),
    });
  }

  // 6. Dangling skill links — ANY agent referencing a missing/disabled skill.
  {
    const samples: SystemSample[] = [];
    for (const a of agentRows) {
      for (const s of a.skillSlugs ?? []) {
        if (!enabledSkillSlugs.has(s)) samples.push({ id: `${a.slug}:${s}`, detail: `${a.slug} → skill '${s}' missing or disabled` });
      }
    }
    checks.push({
      key: 'dangling-skills',
      label: 'Dangling skill references',
      severity: 'high',
      ok: samples.length === 0,
      detail: samples.length === 0 ? 'every agent skill slug resolves to an enabled skill' : `${samples.length} dangling skill ref(s) — the behaviour silently drops`,
      samples: samples.slice(0, 25),
    });
  }

  // 7. Tool group → tool links — manifest groups' bundled tools must resolve.
  //    (Skills carry no tools as of P4 — there is no skill→tool check anymore.)
  {
    const samples: SystemSample[] = [];
    for (const g of MANIFEST_TOOL_GROUPS) {
      const row = toolGroupBySlug.get(g.slug);
      if (!row) {
        samples.push({ id: g.slug, detail: `tool group '${g.slug}' is not seeded` });
        continue;
      }
      for (const t of row.toolSlugs ?? []) {
        if (!enabledToolSlugs.has(t)) samples.push({ id: `${g.slug}:${t}`, detail: `tool group '${g.slug}' → tool '${t}' has no enabled row` });
      }
    }
    checks.push({
      key: 'group-tools',
      label: 'Tool group ↔ tool links',
      severity: 'medium',
      ok: samples.length === 0,
      detail: samples.length === 0 ? 'every tool group is seeded and its tools resolve' : `${samples.length} tool-group issue(s)`,
      samples: samples.slice(0, 25),
    });
  }

  // 7c. Dangling tool-group references — ANY agent granting a missing/disabled group.
  {
    const samples: SystemSample[] = [];
    for (const a of agentRows) {
      for (const g of a.toolGroupSlugs ?? []) {
        if (!enabledToolGroupSlugs.has(g)) samples.push({ id: `${a.slug}:${g}`, detail: `${a.slug} → tool group '${g}' missing or disabled` });
      }
    }
    checks.push({
      key: 'dangling-groups',
      label: 'Dangling tool-group references',
      severity: 'high',
      ok: samples.length === 0,
      detail: samples.length === 0 ? 'every agent tool-group grant resolves to an enabled group' : `${samples.length} dangling tool-group ref(s) — the capability silently drops`,
      samples: samples.slice(0, 25),
    });
  }

  // 8. Memory workers — a default, enabled worker for each required kind.
  {
    const defaultEnabledKinds = new Set(workers.filter((w) => w.enabled && w.isDefault).map((w) => w.kind));
    const samples: SystemSample[] = [];
    for (const w of MANIFEST_WORKERS) {
      if (w.required && !defaultEnabledKinds.has(w.kind)) {
        samples.push({ id: w.kind, detail: `no default+enabled '${w.kind}' worker — the brain won’t ${w.kind === 'extractor' ? 'index' : 'run that step'}` });
      }
    }
    checks.push({
      key: 'workers',
      label: 'Memory workers',
      severity: 'high',
      ok: samples.length === 0,
      detail: samples.length === 0 ? 'extractor · summarizer · reflector · document ready' : `${samples.length} required worker(s) missing`,
      samples,
    });
  }

  // 9. Editor Assist binding — /pages + /tables panels must resolve to an agent.
  {
    const [pagesAssist, tablesAssist] = await Promise.all([
      resolveAssistAgentSlug(ownerId, 'pages'),
      resolveAssistAgentSlug(ownerId, 'tables'),
    ]);
    const samples: SystemSample[] = [];
    if (!pagesAssist) samples.push({ id: 'pages', detail: '/pages Assist resolves to no agent (409s)' });
    if (!tablesAssist) samples.push({ id: 'tables', detail: '/tables Assist resolves to no agent (409s)' });
    checks.push({
      key: 'assist',
      label: 'Editor Assist binding',
      severity: 'high',
      ok: samples.length === 0,
      detail: samples.length === 0 ? `pages → ${pagesAssist} · tables → ${tablesAssist}` : 'an editor Assist panel has no agent to invoke',
      samples,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    checks,
    problems: checks.filter((c) => !c.ok).length,
  };
}
