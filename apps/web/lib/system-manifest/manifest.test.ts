import { describe, it, expect } from 'vitest';
import {
  MANIFEST_AGENTS,
  MANIFEST_SKILLS,
  MANIFEST_TOOL_GROUPS,
  MANIFEST_HTTP_TOOLS,
  MANIFEST_HTTP_TOOL_SLUGS,
  MANIFEST_WORKERS,
  KNOWN_TOOL_SLUGS,
  KNOWN_TOOL_GROUP_SLUGS,
  DELEGATE_SLUGS,
  PERSONA_SLUG,
  ASSIST_SURFACE_DEFAULTS,
  type ManifestAgent,
} from './manifest';
import { BUILTIN_TOOLS, collectParamNames, collectSecretRefs } from '@mantle/tools';

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
  const groupTools = new Map(MANIFEST_TOOL_GROUPS.map((g) => [g.slug, g.toolSlugs]));

  /** P6: an agent's effective tool set is exactly the union of its granted
   *  groups' tools — the sole grant mechanism. */
  const effectiveTools = (agent: ManifestAgent): Set<string> => {
    const set = new Set<string>();
    for (const g of agent.toolGroupSlugs ?? []) for (const t of groupTools.get(g) ?? []) set.add(t);
    return set;
  };

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

  it('every agent is authored as pure tool groups (P6) and references only known groups/skills', () => {
    for (const agent of MANIFEST_AGENTS) {
      // P6: grants are GROUPS only — there is no direct tool_slugs field on a
      // manifest agent anymore (enforced by the type; the column was dropped in
      // migration 0083). Every agent must grant at least one group to act.
      const groups = agent.toolGroupSlugs ?? [];
      expect(groups.length, `agent '${agent.slug}' grants no tool groups — cannot act`).toBeGreaterThan(0);

      const unknownGroups = groups.filter((g) => !KNOWN_TOOL_GROUP_SLUGS.has(g));
      expect(unknownGroups, `agent '${agent.slug}' references unknown tool groups`).toEqual([]);

      // Effective set (the group union) resolves to known builtins only.
      const unknownTools = [...effectiveTools(agent)].filter((t) => !KNOWN_TOOL_SLUGS.has(t));
      expect(unknownTools, `agent '${agent.slug}' effective set has unknown tools`).toEqual([]);

      const unknownSkills = agent.skillSlugs.filter((s) => !skillSlugs.has(s));
      expect(unknownSkills, `agent '${agent.slug}' references unknown skills`).toEqual([]);
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
    // the surface's agent must hold its surface tools (via its groups)
    const pagesAgent = MANIFEST_AGENTS.find((a) => a.slug === ASSIST_SURFACE_DEFAULTS.pages)!;
    expect(effectiveTools(pagesAgent).has('page_create')).toBe(true);
    const tablesAgent = MANIFEST_AGENTS.find((a) => a.slug === ASSIST_SURFACE_DEFAULTS.tables)!;
    expect(effectiveTools(tablesAgent).has('table_from_text')).toBe(true);
  });

  it('every grantable builtin lives in at least one tool group (P6 — groups are total)', () => {
    const inAGroup = new Set(MANIFEST_TOOL_GROUPS.flatMap((g) => g.toolSlugs));
    // Every static builtin must be grantable via some group. (Runtime-only
    // affordances like heartbeat_* are registered outside BUILTIN_TOOLS and are
    // injected per-turn, never granted — so they're correctly absent here.)
    const orphans = BUILTIN_TOOLS.map((t) => t.slug).filter((s) => !inAGroup.has(s));
    expect(orphans, 'these builtins are grantable but belong to no group').toEqual([]);
  });

  it('the persona delegates page/table work — holds no page_*/table_* authoring, but can delegate (P5/P6)', () => {
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    const grant = effectiveTools(persona);
    expect(grant.has('run_terminal'), 'run_terminal stays out').toBe(false);
    expect(grant.has('page_create'), 'page authoring is delegated to the Pages specialist').toBe(false);
    expect(grant.has('page_delete'), 'page delete is delegated to the Pages specialist').toBe(false);
    expect(grant.has('table_from_text'), 'grid work is delegated to the Ledger specialist').toBe(false);
    expect(grant.has('contact_delete'), 'destructive contact delete is deliberate-only').toBe(false);
    expect(grant.has('lifelog_delete'), 'destructive lifelog delete is deliberate-only').toBe(false);
    expect(grant.has('invoke_agent'), 'persona must be able to delegate').toBe(true);
    expect(grant.has('page_share'), 'persona keeps page sharing').toBe(true);
    // …and the Pages specialist DOES own page authoring (so delegation has a target).
    const pages = MANIFEST_AGENTS.find((a) => a.slug === 'pages')!;
    expect(effectiveTools(pages).has('page_create'), 'Pages agent authors pages').toBe(true);
  });

  it('seeded HTTP tools are well-formed, declare every placeholder, and use a vault ref', () => {
    const slugs = MANIFEST_HTTP_TOOLS.map((t) => t.slug);
    expect(new Set(slugs).size, 'duplicate HTTP tool slug').toBe(slugs.length);
    expect(MANIFEST_HTTP_TOOL_SLUGS).toEqual(slugs);
    for (const tool of MANIFEST_HTTP_TOOLS) {
      expect(tool.handler.kind, `${tool.slug} must be an http handler`).toBe('http');
      expect(tool.handler.url, `${tool.slug} url`).toMatch(/^https?:\/\//);
      expect(tool.description.trim().length, `${tool.slug} description`).toBeGreaterThan(0);
      const props = new Set(Object.keys((tool.inputSchema.properties as object) ?? {}));
      // Every {param} placeholder must be a declared input (else the model can
      // never fill it) — the same check the Toolsmith create path warns on.
      for (const p of collectParamNames(tool.handler)) {
        expect(props.has(p), `${tool.slug}: placeholder {${p}} is not in input_schema`).toBe(true);
      }
      // Auth rides a vault ref, never an inline key.
      expect(collectSecretRefs(tool.handler).length, `${tool.slug} must reference a vault key`).toBeGreaterThan(0);
    }
  });

  it('every seeded HTTP tool is bundled by at least one tool group (grantable)', () => {
    const inAGroup = new Set(MANIFEST_TOOL_GROUPS.flatMap((g) => g.toolSlugs));
    const orphans = MANIFEST_HTTP_TOOL_SLUGS.filter((s) => !inAGroup.has(s));
    expect(orphans, 'these HTTP tools belong to no group').toEqual([]);
  });

  it('the persona holds the location group + skill (geo awareness ships on by default)', () => {
    const persona = MANIFEST_AGENTS.find((a) => a.isPersona)!;
    expect(persona.toolGroupSlugs ?? []).toContain('location');
    expect(persona.skillSlugs).toContain('location_awareness');
    const grant = effectiveTools(persona);
    expect(grant.has('location_nearby')).toBe(true);
    expect(grant.has('mapbox_reverse_geocode')).toBe(true);
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
