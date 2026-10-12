/**
 * The one MCP surface (W7b fix round 2), driven through registerPreparedTools
 * against a capturing fake server. The scope wrapper is a pass-through here
 * (it needs a database); what is pinned is what sits under it:
 *
 *  - L-a: a connector tool registers on the same server as every builtin,
 *    so a member's connector call runs under its create home;
 *  - M-a: a connection outside an Admin scope carries `ownerKeysOff` to the
 *    builtins and the connectors (no spending on the owner's keys), an
 *    Admin's does not;
 *  - a user outside Admin in no workspace (no private workspace) has its
 *    creates refused with a reply that says why, not by the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./owner-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./owner-scope')>()),
  ownerScopedServer: (server: unknown) => server,
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  // The connector audit row: best effort, no database here.
  asSystem: vi.fn(async () => undefined),
}));
vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tools')>()),
  loginConnectorRefused: vi.fn(async () => null),
  dispatchTool: vi.fn(),
}));

import { currentCreateHome, type Tool } from '@mantle/db';
import { dispatchTool } from '@mantle/tools';
import { NO_WORKSPACE_CREATE_ERROR, MCP_CREATE_TOOL_SLUGS } from './create-home';
import {
  preparedKeysOff,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';

type Cb = (
  args: unknown,
  extra: unknown,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const CONNECTOR = {
  slug: 'mcp_crm_lookup',
  description: 'Look a customer up in the CRM.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  handler: { kind: 'mcp', group: 'crm', toolName: 'lookup' },
  externalAccess: null,
  requiresConfirm: false,
} as unknown as Tool;

const member: McpCaller = {
  role: 'member',
  anchorId: 'anchor-1',
  loginId: 'member-1',
  via: 'oauth',
  write: true,
};

function prepared(
  caller: McpCaller,
  holdsAdmin: boolean,
  privateWs: string | null,
): PreparedCallerTools {
  return {
    kind: 'owner',
    caller,
    view: { holdsAdmin, areas: new Set() },
    privateWs,
    connectors: [CONNECTOR],
  };
}

function register(p: PreparedCallerTools): Map<string, Cb> {
  const cbs = new Map<string, Cb>();
  const fake = {
    registerTool: (name: string, _config: unknown, cb: Cb) => void cbs.set(name, cb),
  };
  registerPreparedTools(fake as never, p);
  return cbs;
}

let seen: { home: unknown; mcp: unknown } | null = null;
beforeEach(() => {
  seen = null;
  vi.mocked(dispatchTool).mockReset();
  vi.mocked(dispatchTool).mockImplementation(async (_row, _args, ctx) => {
    seen = {
      home: currentCreateHome(),
      mcp: (ctx.surface as { mcp?: unknown } | undefined)?.mcp,
    };
    return { ok: true, output: { found: 1 } } as never;
  });
});

describe('connector tools share the builtins’ server (L-a)', () => {
  it('a member’s connector call runs under its create home, keys off', async () => {
    const cbs = register(prepared(member, false, 'ws-private-1'));
    const call = cbs.get(CONNECTOR.slug);
    expect(call).toBeTypeOf('function');
    const r = await call!({ q: 'acme' }, {});
    expect(r.isError).toBeFalsy();
    expect(seen?.home).toEqual({ createWs: null, privateWs: 'ws-private-1' });
    expect(seen?.mcp).toMatchObject({
      via: 'oauth',
      write: true,
      ownerKeysOff: true,
      role: 'member',
    });
  });

  it('an Admin’s connector call: no private home, keys on', async () => {
    const admin = { ...member, role: 'admin' as const, loginId: 'admin-1' };
    const p = prepared(admin, true, null);
    expect(preparedKeysOff(p)).toBe(false);
    const cbs = register(p);
    await cbs.get(CONNECTOR.slug)!({ q: 'acme' }, {});
    expect(seen?.home).toBeNull();
    expect((seen?.mcp as { ownerKeysOff?: boolean }).ownerKeysOff).toBeUndefined();
    // The app data tools fill :host_me_kind from it (W8 integration).
    expect((seen?.mcp as { role?: string }).role).toBe('admin');
  });
});

describe('a user outside Admin in no workspace (W7b fix round 2)', () => {
  it('each create is refused with a reply that says why, before the tool runs', async () => {
    const p = prepared(member, false, null);
    expect(preparedKeysOff(p)).toBe(true);
    const cbs = register(p);
    for (const slug of ['note_create', 'page_create', 'task_create', 'folder_create']) {
      expect(MCP_CREATE_TOOL_SLUGS.has(slug), slug).toBe(true);
      const cb = cbs.get(slug);
      expect(cb, slug).toBeTypeOf('function');
      const r = await cb!({ title: 'x', content: 'y', name: 'z' }, {});
      expect(r.isError, slug).toBe(true);
      expect(r.content[0]?.text, slug).toContain(NO_WORKSPACE_CREATE_ERROR);
    }
  });
});
