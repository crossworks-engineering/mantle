/**
 * The agent UI tools stay in-app (docs/agent-ui.md): never put in a tool
 * group (tool_group_ensure refuses, before any read or write), never granted
 * from one (the agent's stored grant leaves them out), and a delegated
 * agent never gets the person's window (childSurface). The web route's own
 * refusal: server/web/lib/tool-groups-ui.test.ts. No database.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_UI_ACTIONS, isAgentUiToolSlug } from '@mantle/client-types/agent-ui';

const h = vi.hoisted(() => ({ dbTouched: 0, groupRows: [] as Array<{ toolSlugs: string[] }> }));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain: Record<string, unknown> = {};
  chain['from'] = () => chain;
  chain['where'] = () => chain;
  chain['limit'] = async () => {
    h.dbTouched += 1;
    return [{ slug: 'helper', toolGroupSlugs: ['g'], admin: true }];
  };
  chain['then'] = (res: (v: unknown) => void) => {
    return Promise.resolve(h.groupRows).then(res);
  };
  return {
    ...actual,
    db: {
      select: () => {
        h.dbTouched += 1;
        return chain;
      },
    },
  };
});

const { childSurface } = await import('./builtins-delegation');
const { tool_group_ensure } = await import('./toolsmith/groups');
const { loadAgentGrant } = await import('./agent-grants');

describe('isAgentUiToolSlug', () => {
  it('names the seven ui tools and nothing else', () => {
    for (const a of AGENT_UI_ACTIONS) expect(isAgentUiToolSlug(`ui_${a}`), a).toBe(true);
    for (const s of ['ui_', 'ui_other', 'page_get', 'xui_click', 'UI_CLICK']) {
      expect(isAgentUiToolSlug(s), s).toBe(false);
    }
  });
});

describe('a tool group never holds a ui tool', () => {
  it('tool_group_ensure refuses one, before anything is read or written', async () => {
    h.dbTouched = 0;
    const res = await tool_group_ensure.handler(
      { slug: 'sneaky', name: 'Sneaky', tool_slugs: ['page_get', 'ui_click'] },
      { ownerId: 'o' } as never,
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('ui_click');
    expect(h.dbTouched).toBe(0);
  });

  it("an agent's stored grant leaves a ui tool out, whatever a group names", async () => {
    h.groupRows = [{ toolSlugs: ['page_get', 'ui_click', 'ui_screen'] }];
    const grant = await loadAgentGrant('o', { slug: 'helper' });
    expect([...grant!.toolSlugs]).toEqual(['page_get']);
  });
});

describe('a delegated agent never gets the window', () => {
  it('the window leaves the surface, on an owner turn and a workspace turn', () => {
    expect(
      childSurface({ kind: 'web', loginId: 'l1', uiWindowId: 'win_abcdefgh' } as never),
    ).toEqual({ kind: 'owner', via: 'delegate', loginId: 'l1' });
    const team = childSurface({ kind: 'team', loginId: 'l2', uiWindowId: 'win_abcdefgh' } as never);
    expect(team).toEqual({ kind: 'team', loginId: 'l2' });
    expect(team).not.toHaveProperty('uiWindowId');
  });
});
