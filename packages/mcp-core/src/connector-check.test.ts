/**
 * A connection that only reads calls a connector tool an Admin marked
 * read-only with only the inputs it was marked with, in any scope (A5 step
 * 5 fix round 1, L2). Since Q1 a read-only key or peer lists and calls a
 * marked tool; dispatch applies the mark below the owner and in a workspace
 * scope, but not on an owner surface outside one, which a read-only admin
 * key or peer is. The MCP connector check (connectorCheck, the call's
 * pre-run slot) applies it for any caller whose `write` is off. The
 * connector's workspace rule is stood in (it reads the database).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tools')>()),
  loginConnectorRefused: vi.fn(async () => null),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  // The call's audit row: best effort, never read here.
  asSystem: vi.fn(async () => undefined),
}));

import type { Tool } from '@mantle/db';
import { externalAccessToolSig } from '@mantle/tools';
import { connectorCheck, type McpCaller } from './login-surface';

const list = {
  slug: 'mcp_crm_contacts_list',
  description: 'The crm contacts list.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  handler: { kind: 'mcp', group: 'mcp-crm', toolName: 'contacts_list' },
  requiresConfirm: false,
  externalAccess: null,
} as unknown as Tool;
const marked = {
  ...list,
  externalAccess: {
    confirmedReadOnlyAt: new Date(0).toISOString(),
    by: { via: 'web' },
    handlerSig: externalAccessToolSig(list),
  },
} as Tool;

const caller = (via: McpCaller['via'], write: boolean): McpCaller => ({
  role: 'admin',
  anchorId: '99999999-9999-4999-8999-999999999999',
  loginId: '55555555-5555-4555-8555-555555555555',
  via,
  write,
});

describe('a read-only connection keeps a marked connector tool to its marked inputs (L2)', () => {
  for (const via of ['key', 'peer', 'oauth'] as const) {
    it(`a read-only ${via}: an input the tool was not marked with is refused`, async () => {
      const refused = await connectorCheck(caller(via, false))(marked, { q: 'acme', drop: true });
      expect(refused).toMatch(/marked read-only with the inputs it had then, and 'drop'/);
    });

    it(`a read-only ${via}: the marked inputs run`, async () => {
      expect(await connectorCheck(caller(via, false))(marked, { q: 'acme' })).toBeNull();
    });
  }

  it('a connection that writes is not held to the mark here (dispatch keeps its own rules)', async () => {
    expect(await connectorCheck(caller('key', true))(marked, { q: 'acme', drop: true })).toBeNull();
  });
});
