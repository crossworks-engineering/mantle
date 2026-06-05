import { describe, it, expect } from 'vitest';
import {
  MANIFEST_AGENTS,
  MANIFEST_SKILLS,
  MANIFEST_WORKERS,
  KNOWN_TOOL_SLUGS,
  DELEGATE_SLUGS,
  PERSONA_SLUG,
  ASSIST_SURFACE_DEFAULTS,
  resolveManifestToolSlugs,
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

  it('every skill bundles only known builtin tools', () => {
    for (const skill of MANIFEST_SKILLS) {
      const unknown = skill.toolSlugs.filter((t) => !KNOWN_TOOL_SLUGS.has(t));
      expect(unknown, `skill '${skill.slug}' references unknown tools`).toEqual([]);
    }
  });

  it('every agent grants only known tools and references only manifest skills', () => {
    for (const agent of MANIFEST_AGENTS) {
      const tools = resolveManifestToolSlugs(agent);
      const unknownTools = tools.filter((t) => !KNOWN_TOOL_SLUGS.has(t));
      expect(unknownTools, `agent '${agent.slug}' references unknown tools`).toEqual([]);

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
    // the surface's agent must hold its surface tools
    const pagesAgent = MANIFEST_AGENTS.find((a) => a.slug === ASSIST_SURFACE_DEFAULTS.pages)!;
    expect(resolveManifestToolSlugs(pagesAgent)).toContain('page_create');
    const tablesAgent = MANIFEST_AGENTS.find((a) => a.slug === ASSIST_SURFACE_DEFAULTS.tables)!;
    expect(resolveManifestToolSlugs(tablesAgent)).toContain('table_from_text');
  });

  it('the persona tool grant keeps dangerous tools out', () => {
    const grant = new Set(DEFAULT_ASSISTANT_TOOL_SLUGS);
    for (const denied of ['run_terminal', 'page_delete']) {
      expect(grant.has(denied), `${denied} must not be in the persona grant`).toBe(false);
    }
    // the persona must be able to delegate at all
    expect(grant.has('invoke_agent')).toBe(true);
  });

  it('has the required always-on memory workers', () => {
    const required = MANIFEST_WORKERS.filter((w) => w.required).map((w) => w.kind);
    for (const kind of ['extractor', 'summarizer', 'reflector', 'document']) {
      expect(required, `worker '${kind}' must be required`).toContain(kind);
    }
  });
});
