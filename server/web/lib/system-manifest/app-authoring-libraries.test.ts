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
import { MANIFEST_AGENTS, MANIFEST_TOOL_GROUPS } from './manifest';
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

describe('the builders learn the design guide from their skills', () => {
  const groupTools = (slug: string) => {
    const agent = MANIFEST_AGENTS.find((a) => a.slug === slug)!;
    return MANIFEST_TOOL_GROUPS.filter((g) =>
      (agent.toolGroupSlugs ?? []).includes(g.slug),
    ).flatMap((g) => g.toolSlugs);
  };

  it('app_authoring and canvas_authoring say to read design_guide before a build', () => {
    expect(SKILL_INSTRUCTIONS['app_authoring']).toContain(
      "`design_guide` with `topic: 'mini-app'`",
    );
    expect(SKILL_INSTRUCTIONS['canvas_authoring']).toContain('`design_guide` with the task');
  });

  it('Appsmith and Presenter hold design_guide, and so does every holder of present', () => {
    expect(groupTools('appsmith')).toContain('design_guide');
    expect(groupTools('presenter')).toContain('design_guide');
    const present = MANIFEST_TOOL_GROUPS.find((g) => g.slug === 'present')!;
    expect(present.toolSlugs).toContain('design_guide');
  });
});
