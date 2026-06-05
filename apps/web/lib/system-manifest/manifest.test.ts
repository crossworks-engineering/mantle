import { describe, it, expect } from 'vitest';
import {
  MANIFEST_AGENTS,
  MANIFEST_SKILLS,
  MANIFEST_TOOL_GROUPS,
  MANIFEST_WORKERS,
  KNOWN_TOOL_SLUGS,
  KNOWN_TOOL_GROUP_SLUGS,
  DELEGATE_SLUGS,
  PERSONA_SLUG,
  ASSIST_SURFACE_DEFAULTS,
  resolveManifestToolSlugs,
  deriveGroupGrants,
} from './manifest';
import { DEFAULT_ASSISTANT_TOOL_SLUGS } from '@mantle/tools';

/**
 * Manifest drift guard (modeled on packages/voice/.../catalog-consistency.test.ts).
 * A typo'd or dangling slug — a skill that bundles a tool with no row, an agent
 * that references a skill that doesn't exist, a delegate target that isn't an
 * agent — fails CI here, instead of degrading silently at runtime. This is how
 * we keep the vital links honest as new tools/skills are added.
 */
describe('system manifest integrity', () => {
  const skillSlugs = new Set(MANIFEST_SKILLS.map((s) => s.slug));
  const agentSlugs = new Set(MANIFEST_AGENTS.map((a) => a.slug));

  it('has no duplicate slugs', () => {
    expect(MANIFEST_SKILLS.length).toBe(skillSlugs.size);
    expect(MANIFEST_AGENTS.length).toBe(agentSlugs.size);
    const workerKinds = MANIFEST_WORKERS.map((w) => w.kind);
    expect(new Set(workerKinds).size).toBe(workerKinds.length);
  });

  it('every tool group bundles only known builtin tools, with unique slugs', () => {
    const groupSlugs = MANIFEST_TOOL_GROUPS.map((g) => g.slug);
    expect(new Set(groupSlugs).size, 'duplicate tool-group slug').toBe(groupSlugs.length);
    for (const group of MANIFEST_TOOL_GROUPS) {
      const unknown = group.toolSlugs.filter((t) => !KNOWN_TOOL_SLUGS.has(t));
      expect(unknown, `tool group '${group.slug}' references unknown tools`).toEqual([]);
      expect(group.toolSlugs.length, `tool group '${group.slug}' is empty`).toBeGreaterThan(0);
    }
  });

  it('every agent grants only known tools/groups and references only manifest skills', () => {
    for (const agent of MANIFEST_AGENTS) {
      const tools = resolveManifestToolSlugs(agent);
      const unknownTools = tools.filter((t) => !KNOWN_TOOL_SLUGS.has(t));
      expect(unknownTools, `agent '${agent.slug}' references unknown tools`).toEqual([]);

      const unknownSkills = agent.skillSlugs.filter((s) => !skillSlugs.has(s));
      expect(unknownSkills, `agent '${agent.slug}' references unknown skills`).toEqual([]);

      const unknownGroups = (agent.toolGroupSlugs ?? []).filter((g) => !KNOWN_TOOL_GROUP_SLUGS.has(g));
      expect(unknownGroups, `agent '${agent.slug}' references unknown tool groups`).toEqual([]);
    }
  });

  it('exactly one persona, and every delegate target is a real specialist agent', () => {
    expect(MANIFEST_AGENTS.filter((a) => a.isPersona)).toHaveLength(1);
    expect(agentSlugs.has(PERSONA_SLUG)).toBe(true);
    for (const slug of DELEGATE_SLUGS) {
      expect(agentSlugs.has(slug), `delegate target '${slug}' is not a manifest agent`).toBe(true);
      // the persona must not delegate to itself
      expect(slug).not.toBe(PERSONA_SLUG);
    }
  });

  it('each assist surface maps to a unique agent', () => {
    const surfaces = MANIFEST_AGENTS.filter((a) => a.assistSurface).map((a) => a.assistSurface);
    expect(new Set(surfaces).size).toBe(surfaces.length);
    expect(ASSIST_SURFACE_DEFAULTS.pages).toBeTruthy();
    expect(ASSIST_SURFACE_DEFAULTS.tables).toBeTruthy();
    // the surface's agent must hold its surface tools
    const pagesAgent = MANIFEST_AGENTS.find((a) => a.slug === ASSIST_SURFACE_DEFAULTS.pages)!;
    expect(resolveManifestToolSlugs(pagesAgent)).toContain('page_create');
    const tablesAgent = MANIFEST_AGENTS.find((a) => a.slug === ASSIST_SURFACE_DEFAULTS.tables)!;
    expect(resolveManifestToolSlugs(tablesAgent)).toContain('table_from_text');
  });

  it('deriveGroupGrants re-expresses every agent losslessly (residual ∪ groups === full)', () => {
    const groupTools = new Map(MANIFEST_TOOL_GROUPS.map((g) => [g.slug, g.toolSlugs]));
    for (const agent of MANIFEST_AGENTS) {
      const full = resolveManifestToolSlugs(agent);
      const { toolSlugs, toolGroupSlugs } = deriveGroupGrants(full);
      // every granted group is a real manifest group
      for (const g of toolGroupSlugs) expect(groupTools.has(g), `agent '${agent.slug}' → unknown group '${g}'`).toBe(true);
      // residual ∪ granted-group tools reassembles the full set exactly
      const reassembled = new Set(toolSlugs);
      for (const g of toolGroupSlugs) for (const t of groupTools.get(g)!) reassembled.add(t);
      expect([...reassembled].sort(), `agent '${agent.slug}' re-expression is lossy`).toEqual([...new Set(full)].sort());
      // residual carries no tool already covered by a granted group (no double-grant)
      const covered = new Set(toolGroupSlugs.flatMap((g) => groupTools.get(g)!));
      expect(toolSlugs.filter((t) => covered.has(t)), `agent '${agent.slug}' residual overlaps a group`).toEqual([]);
    }
  });

  it('the persona keeps run_terminal out, but deliberately carries page_delete (P1 decision 1)', () => {
    // page_delete is NOT in the registry-tracked base grant…
    const base = new Set(DEFAULT_ASSISTANT_TOOL_SLUGS);
    expect(base.has('run_terminal')).toBe(false);
    expect(base.has('page_delete')).toBe(false);
    // …it's added back as an explicit extra so the capability the persona had via
    // the old rich_writing skill is preserved. run_terminal stays out entirely.
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    const grant = new Set(resolveManifestToolSlugs(persona));
    expect(grant.has('run_terminal'), 'run_terminal must stay out of the persona').toBe(false);
    expect(grant.has('page_delete'), 'page_delete preserved via extraToolSlugs').toBe(true);
    expect(grant.has('invoke_agent'), 'persona must be able to delegate').toBe(true);
  });

  it('every skill has a non-empty instruction body', () => {
    for (const skill of MANIFEST_SKILLS) {
      expect(skill.instructions?.trim().length, `skill '${skill.slug}' has no instructions`).toBeGreaterThan(0);
    }
  });

  it('every specialist agent has a system prompt; the persona has none (persona-bank)', () => {
    for (const agent of MANIFEST_AGENTS) {
      if (agent.isPersona) {
        expect(agent.systemPrompt, `persona '${agent.slug}' should not carry a manifest prompt`).toBeUndefined();
      } else {
        expect(agent.systemPrompt?.trim().length, `agent '${agent.slug}' has no system prompt`).toBeGreaterThan(0);
      }
    }
  });

  it('has the required always-on memory workers', () => {
    const required = MANIFEST_WORKERS.filter((w) => w.required).map((w) => w.kind);
    for (const kind of ['extractor', 'summarizer', 'reflector', 'document']) {
      expect(required, `worker '${kind}' must be required`).toContain(kind);
    }
  });
});
