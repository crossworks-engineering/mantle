/**
 * The MCP surface of the System split (docs/workspaces.md, "Admin areas"),
 * over the real SDK, per person and per credential. The area rule itself is
 * the database's (mantle_area_rule): here the scope's answer is the view the
 * gate reads (AdminGateView), as prepareCallerTools builds it.
 *
 *  - A System user (an Admin user in System): every area.
 *  - An Admin user outside System: the users area only.
 *  - A member: no area.
 * Each over OAuth, an API key and a peer acting as that login. A
 * System-only login cannot exist (out of Admin is out of System).
 *
 * The users area holds the users tools, the pending queue's and the mail
 * tools (moved from connectors); every tool of settings, assistants,
 * connectors and keys needs System. Adding to System is no tool:
 * system_user_add is a reserved person-only name, and workspace_user_set
 * refuses System (its database cells: server/web/server/system-areas.db.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import type { ScopeArea } from '@mantle/db';
import { BUILTIN_TOOLS, isPersonOnlyTool, type AdminGateView } from '@mantle/tools';
import { registerPreparedTools, type McpCaller, type PreparedCallerTools } from './login-surface';

const LOGIN = '00000000-0000-4000-8000-0000000000bb';
const ALL: ScopeArea[] = ['settings', 'users', 'assistants', 'connectors', 'keys'];
const SYSTEM_AREAS = ['settings', 'assistants', 'connectors', 'keys'];

const VIEWS: Record<'system' | 'admin' | 'member', AdminGateView> = {
  system: { holdsAdmin: true, areas: new Set<ScopeArea>(ALL) },
  admin: { holdsAdmin: true, areas: new Set<ScopeArea>(['users']) },
  member: { holdsAdmin: false, areas: new Set<ScopeArea>() },
};

const VIAS: Record<string, (role: 'admin' | 'member') => McpCaller> = {
  oauth: (role) => ({ role, anchorId: 'a', loginId: LOGIN, via: 'oauth', write: true }),
  key: (role) => ({
    role,
    anchorId: 'a',
    loginId: LOGIN,
    via: 'key',
    write: true,
    areas: null,
    keyId: 'k',
  }),
  peer: (role) => ({
    role,
    anchorId: 'a',
    loginId: LOGIN,
    via: 'peer',
    write: true,
    riskyAllowed: ['email_send'],
  }),
};

/** Each builtin's Admin area, or null. */
const areaOf = new Map(
  BUILTIN_TOOLS.map((d) => {
    const s = (d.policy as { scope?: unknown }).scope;
    const area = s && typeof s === 'object' ? ((s as { area?: string }).area ?? null) : null;
    return [d.slug, area] as const;
  }),
);

async function listed(p: PreparedCallerTools): Promise<Set<string>> {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  registerPreparedTools(server, p, { transport: 'http' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'system-surface', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

const prepared = (who: keyof typeof VIEWS, via: string): PreparedCallerTools => ({
  kind: 'owner',
  caller: VIAS[via]!(who === 'member' ? 'member' : 'admin'),
  view: VIEWS[who],
  privateWs: null,
  connectors: [],
});

describe('the System split on the MCP surface', () => {
  it('the moved tools are the users area; the technical tools are not', () => {
    for (const slug of ['email_list', 'email_get', 'email_page', 'email_send']) {
      expect(areaOf.get(slug), slug).toBe('users');
    }
    for (const slug of ['users_list', 'workspace_user_set']) {
      expect(areaOf.get(slug), slug).toBe('users');
    }
    // Every area keeps tools of its own (the split is not empty anywhere).
    for (const area of SYSTEM_AREAS) {
      expect([...areaOf.values()].filter((a) => a === area).length, area).toBeGreaterThan(0);
    }
  });

  it.each(Object.keys(VIAS))('%s: a System user lists every area tool', async (via) => {
    const names = await listed(prepared('system', via));
    const areaTools = [...areaOf].filter(([, a]) => a !== null).map(([s]) => s);
    // Not every area tool is on every credential (a key or a peer narrows
    // risky ones), but each area is reached.
    for (const area of [...SYSTEM_AREAS, 'users']) {
      const of = areaTools.filter((s) => areaOf.get(s) === area);
      expect(
        of.some((s) => names.has(s)),
        `${via} ${area}`,
      ).toBe(true);
    }
  });

  it.each(Object.keys(VIAS))(
    '%s: an Admin user outside System lists the users area, never a System area',
    async (via) => {
      const sys = await listed(prepared('system', via));
      const names = await listed(prepared('admin', via));
      const leaked = [...names].filter((s) => SYSTEM_AREAS.includes(areaOf.get(s) ?? ''));
      expect(leaked).toEqual([]);
      // What the System user gets of the users area, the Admin user gets too.
      const usersArea = [...sys].filter((s) => areaOf.get(s) === 'users');
      expect(usersArea.length).toBeGreaterThan(0);
      for (const s of usersArea) expect(names.has(s), `${via} ${s}`).toBe(true);
      expect(names.has('pending_list')).toBe(sys.has('pending_list'));
      // A subset of the System user's list.
      for (const s of names) expect(sys.has(s), `${via} ${s}`).toBe(true);
    },
  );

  it.each(Object.keys(VIAS))('%s: a member lists no area tool', async (via) => {
    const names = await listed(prepared('member', via));
    expect([...names].filter((s) => areaOf.get(s) !== null && areaOf.get(s) !== undefined)).toEqual(
      [],
    );
  });

  it('adding to System is no tool: a reserved person-only name, on no surface', async () => {
    expect(isPersonOnlyTool('system_user_add')).toBe(true);
    expect(BUILTIN_TOOLS.some((d) => d.slug === 'system_user_add')).toBe(false);
    for (const via of Object.keys(VIAS)) {
      expect((await listed(prepared('system', via))).has('system_user_add'), via).toBe(false);
    }
  });
});
