import { describe, it, expect } from 'vitest';
import { TOOLSMITH_TOOLS, TOOLSMITH_TOOL_SLUGS } from './builtins-toolsmith';

/**
 * builtins-toolsmith.ts was one 1924-line module; it is now a 49-line
 * assembly barrel over toolsmith/{common,web-fetch,api-tools,docs,recipes,
 * groups}.ts, the same shape builtins.ts uses over builtins-*.ts.
 *
 * The whole set is granted to the Toolsmith specialist through one tool
 * group, so the list IS the grant: a definition silently dropped by a bad
 * merge takes an ability away from a shipped agent, and a definition added
 * here widens what that agent may do without anyone approving it. Order is
 * pinned too, because BUILTIN_TOOLS is assembled from these in sequence and
 * dispatch resolves first-match.
 */
const SLUGS = [
  'web_fetch',
  'api_tool_list',
  'api_tool_get',
  'api_tool_create',
  'api_tool_update',
  'api_tool_delete',
  'api_tool_test',
  'api_key_refs',
  'api_docs_set',
  'api_docs_get',
  'api_skill_set',
  'tool_catalog',
  'recipe_tool_create',
  'recipe_tool_test',
  'tool_group_list',
  'tool_group_ensure',
  'agent_list',
  'agent_grant_tool_group',
] as const;

describe('TOOLSMITH_TOOLS', () => {
  it('assembles exactly these tools, in this order', () => {
    expect(TOOLSMITH_TOOLS.map((t) => t.slug)).toEqual([...SLUGS]);
  });

  it('derives the grant list from the same array', () => {
    expect(TOOLSMITH_TOOL_SLUGS).toEqual([...SLUGS]);
  });

  it('gives every tool a handler and a name', () => {
    for (const t of TOOLSMITH_TOOLS) {
      expect(typeof t.handler, t.slug).toBe('function');
      expect(t.name, t.slug).toBeTruthy();
    }
  });
});
