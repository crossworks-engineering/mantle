/**
 * The one MCP surface (W7b fix round 2), driven through registerPreparedTools
 * against a capturing fake server, every call through the one gate and the
 * real dispatch (A5 step 4). The scope entry is a pass-through here (it
 * needs a database); what is pinned is what runs inside it:
 *
 *  - L-a: a connector tool registers on the same server as every builtin,
 *    so a member's connector call runs under its create home;
 *  - M-a: a connection outside an Admin scope carries `ownerKeysOff` to the
 *    builtins and the connectors (no spending on the owner's keys), an
 *    Admin's does not;
 *  - a user outside Admin with no private workspace has its creates
 *    refused with a reply that says why, not by the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seen: null as { home: unknown; mcp: unknown } | null,
  surface: undefined as unknown,
}));

vi.mock('./mcp-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpScopeEntry:
    () =>
    <T>(_writes: boolean, fn: () => Promise<T>) =>
      fn(),
}));
vi.mock('../../db/src/viewer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The connector's binding, and the audit row (best effort): no database.
  asSystem: async (fn: () => Promise<unknown>, reason: string) =>
    reason === 'connector-binding'
      ? [{ slug: 'crm', enabled: true, configuredBy: null, integration: { mcp: { url: 'x' } } }]
      : reason === 'audit-log'
        ? undefined
        : fn(),
}));
vi.mock('../../tools/src/external-access', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loginConnectorRefused: async () => null,
}));
vi.mock('../../tools/src/mcp-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpCallRemoteTool: async () => {
    const { currentCreateHome } = await import('@mantle/db');
    h.seen = { home: currentCreateHome(), mcp: (h.surface as { mcp?: unknown } | undefined)?.mcp };
    return { text: JSON.stringify({ found: 1 }), isError: false, secrets: [] };
  },
}));
vi.mock('@mantle/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tools')>();
  return {
    ...real,
    // The real dispatch, with the surface it was handed noted.
    dispatchTool: (...args: Parameters<typeof real.dispatchTool>) => {
      h.surface = args[2].surface;
      return real.dispatchTool(...args);
    },
  };
});

import type { Tool } from '@mantle/db';
import { NO_WORKSPACE_CREATE_ERROR } from './create-home';
import {
  preparedKeysOff,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';
import { MCP_CREATE_TOOL_SLUGS } from './policy-views.test-helper';

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

const MEMBER = '00000000-0000-4000-8000-0000000000b1';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const PRIVATE_WS = '10000000-0000-4000-8000-000000000003';

const member: McpCaller = {
  role: 'member',
  anchorId: 'anchor-1',
  loginId: MEMBER,
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

beforeEach(() => {
  h.seen = null;
  h.surface = undefined;
});

describe('connector tools share the builtins’ server (L-a)', () => {
  it('a member’s connector call runs under its create home, keys off', async () => {
    const cbs = register(prepared(member, false, PRIVATE_WS));
    const call = cbs.get(CONNECTOR.slug);
    expect(call).toBeTypeOf('function');
    const r = await call!({ q: 'acme' }, {});
    expect(r.isError).toBeFalsy();
    expect(h.seen?.home).toEqual({ createWs: null, privateWs: PRIVATE_WS });
    expect(h.seen?.mcp).toMatchObject({
      via: 'oauth',
      write: true,
      ownerKeysOff: true,
      role: 'member',
    });
  });

  it('an Admin’s connector call: no private home, keys on', async () => {
    const admin = { ...member, role: 'admin' as const, loginId: ADMIN };
    const p = prepared(admin, true, null);
    expect(preparedKeysOff(p)).toBe(false);
    const cbs = register(p);
    await cbs.get(CONNECTOR.slug)!({ q: 'acme' }, {});
    expect(h.seen?.home).toBeNull();
    expect((h.seen?.mcp as { ownerKeysOff?: boolean }).ownerKeysOff).toBeUndefined();
    // The app data tools fill :host_me_kind from it (W8 integration).
    expect((h.seen?.mcp as { role?: string }).role).toBe('admin');
  });
});

describe('a user outside Admin with no private workspace (W7b fix round 2)', () => {
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
