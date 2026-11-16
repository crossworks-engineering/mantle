/**
 * The libraries a mini app may import (@mantle/app-build app-libraries.ts)
 * reach the builder through its SKILL, not its prompt: the skill body
 * force-syncs to every brain on upgrade, a specialist's prompt does not
 * (CLAUDE.md here). Pinned: the app_authoring skill names every library
 * by its exact import and says to call canvas_library first, and Appsmith
 * holds both the skill and the tool.
 */
import { describe, expect, it } from 'vitest';
import { APP_LIBRARY_SPECIFIERS } from '@mantle/app-build';
import { ASSISTANT_CONTENT_KIND_GROUPS, MANIFEST_AGENTS, MANIFEST_TOOL_GROUPS } from './manifest';
import { AGENT_PROMPTS, SKILL_INSTRUCTIONS } from './prompts';

describe('the app builder learns the libraries from its skill', () => {
  const skill = SKILL_INSTRUCTIONS['app_authoring']!;

  it('the app_authoring skill names every library by its exact import', () => {
    for (const spec of APP_LIBRARY_SPECIFIERS) expect(skill, spec).toContain(`\`${spec}\``);
    expect(skill).toContain("`canvas_library` with `for: 'app'`");
  });

  it('Appsmith holds the skill and canvas_library', () => {
    const appsmith = MANIFEST_AGENTS.find((a) => a.slug === 'appsmith')!;
    expect(appsmith.skillSlugs).toContain('app_authoring');
    const tools = MANIFEST_TOOL_GROUPS.filter((g) =>
      (appsmith.toolGroupSlugs ?? []).includes(g.slug),
    ).flatMap((g) => g.toolSlugs);
    expect(tools).toContain('canvas_library');
  });

  it('the prompt does not carry the library list on its own', () => {
    // A rule only the prompt holds would never reach an existing brain.
    for (const spec of APP_LIBRARY_SPECIFIERS) {
      expect(AGENT_PROMPTS['appsmith'] ?? '', spec).not.toContain(`\`${spec}\``);
    }
  });
});

describe('only app and presentation work reaches the design guide (owner, 2026-11-16)', () => {
  const holders = (tool: string) =>
    MANIFEST_TOOL_GROUPS.filter((g) => g.toolSlugs.includes(tool)).map((g) => g.slug);
  const agentsHolding = (group: string) =>
    MANIFEST_AGENTS.filter((a) => (a.toolGroupSlugs ?? []).includes(group)).map((a) => a.slug);

  it('design_guide is in one group, held by Appsmith and Presenter only', () => {
    expect(holders('design_guide')).toEqual(['design-guide']);
    expect(agentsHolding('design-guide').sort()).toEqual(['appsmith', 'presenter']);
  });

  it('no assistant, persona or content-kind group reaches it', () => {
    expect(ASSISTANT_CONTENT_KIND_GROUPS).not.toContain('design-guide');
    for (const a of MANIFEST_AGENTS) {
      if (a.slug === 'appsmith' || a.slug === 'presenter') continue;
      expect(a.toolGroupSlugs ?? [], a.slug).not.toContain('design-guide');
    }
  });

  it('only the app_authoring and canvas_authoring skills name it, and no agent prompt', () => {
    expect(SKILL_INSTRUCTIONS['app_authoring']).toContain(
      "`design_guide` with `topic: 'mini-app'`",
    );
    expect(SKILL_INSTRUCTIONS['canvas_authoring']).toContain('`design_guide` with the task');
    for (const [slug, body] of Object.entries(SKILL_INSTRUCTIONS)) {
      if (slug === 'app_authoring' || slug === 'canvas_authoring') continue;
      expect(body, slug).not.toContain('design_guide');
    }
    for (const [slug, body] of Object.entries(AGENT_PROMPTS)) {
      expect(body, slug).not.toContain('design_guide');
    }
  });
});
