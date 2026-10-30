/**
 * The box policy's Telegram switch on the MCP surface (docs/policy.md): with
 * MANTLE_POLICY_TELEGRAM=off every `telegram_*` tool leaves tools/list and
 * nothing else does; with no policy the list is the one the snapshot pins
 * (mcp-surface-snapshot.test.ts, unchanged by this feature).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { resetBoxPolicyForTests } from '@mantle/config';
import { getBuiltin } from '@mantle/tools';
import { registerMantleTools } from './build-server';

async function names(): Promise<string[]> {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  registerMantleTools(server, 'owner-1', { transport: 'stdio' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'policy-telegram', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

const saved = process.env.MANTLE_POLICY_TELEGRAM;
afterEach(() => {
  if (saved === undefined) delete process.env.MANTLE_POLICY_TELEGRAM;
  else process.env.MANTLE_POLICY_TELEGRAM = saved;
  resetBoxPolicyForTests();
});

describe('MANTLE_POLICY_TELEGRAM', () => {
  it('off: the telegram tools leave tools/list, nothing else does', async () => {
    delete process.env.MANTLE_POLICY_TELEGRAM;
    resetBoxPolicyForTests();
    const all = await names();
    const telegram = all.filter((n) => n.startsWith('telegram_'));
    expect(telegram.length).toBeGreaterThan(0);

    process.env.MANTLE_POLICY_TELEGRAM = 'off';
    resetBoxPolicyForTests();
    const off = await names();
    expect(off.filter((n) => n.startsWith('telegram_'))).toEqual([]);
    expect(off).toEqual(all.filter((n) => !n.startsWith('telegram_')));
  });

  it('off: a telegram tool named anyway answers that Telegram is off', async () => {
    process.env.MANTLE_POLICY_TELEGRAM = 'off';
    resetBoxPolicyForTests();
    const def = getBuiltin('telegram_pending')!;
    const out = await def.handler({}, { ownerId: 'owner-1' } as never);
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(/MANTLE_POLICY_TELEGRAM/);
  });
});
