/**
 * The box policy's email sending switch on the MCP surface (docs/policy.md):
 * with MANTLE_POLICY_EMAIL_SEND=off the send tools (email_send, email_page)
 * leave tools/list and nothing else does (the mail reads stay); with no
 * policy the list is the one the snapshot pins (mcp-surface-snapshot.test.ts,
 * unchanged by this feature).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { EMAIL_SEND_TOOL_SLUGS, resetBoxPolicyForTests } from '@mantle/config';
import { getBuiltin } from '@mantle/tools';
import { registerMantleTools } from './build-server';

async function names(): Promise<string[]> {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  registerMantleTools(server, 'owner-1', { transport: 'stdio' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'policy-email-send', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

function setEmailSend(v: string | undefined): void {
  if (v === undefined) delete process.env.MANTLE_POLICY_EMAIL_SEND;
  else process.env.MANTLE_POLICY_EMAIL_SEND = v;
  resetBoxPolicyForTests();
}

const saved = process.env.MANTLE_POLICY_EMAIL_SEND;
afterEach(() => setEmailSend(saved));

describe('MANTLE_POLICY_EMAIL_SEND', () => {
  it('off: the send tools leave tools/list, nothing else does', async () => {
    setEmailSend(undefined);
    const all = await names();
    for (const slug of EMAIL_SEND_TOOL_SLUGS) expect(all).toContain(slug);
    expect(all).toContain('email_list');
    expect(all).toContain('email_get');

    setEmailSend('off');
    const off = await names();
    expect(off).toEqual(all.filter((n) => !EMAIL_SEND_TOOL_SLUGS.includes(n)));
    expect(off).toContain('email_list');
    expect(off).toContain('email_get');
  });

  it('off: a send tool named anyway answers that sending is off', async () => {
    setEmailSend('off');
    for (const slug of EMAIL_SEND_TOOL_SLUGS) {
      const out = await getBuiltin(slug)!.handler(
        { to: 'friend@example.com', subject: 'Hi', body: 'x', pageId: 'p1' },
        { ownerId: 'owner-1' } as never,
      );
      expect(out, slug).toMatchObject({ ok: false });
      expect((out as { error: string }).error, slug).toMatch(/MANTLE_POLICY_EMAIL_SEND/);
    }
  });
});
